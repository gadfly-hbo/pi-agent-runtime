import {constants} from 'node:fs';
import {open, mkdir, lstat, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve, dirname, basename, join} from 'node:path';
import {spawn} from 'node:child_process';
import {RuntimeFault} from './errors.ts';
import type {ExecutionEnvironment, LocalEnvironmentOptions} from './types.ts';

/** Dedicated host-owned workspace. No process execution outside an OS sandbox. */
export async function createLocalExecutionEnvironment(options: LocalEnvironmentOptions): Promise<ExecutionEnvironment> {
  if (!isAbsolute(options.root) || options.exclusiveWorkspace !== true || !options.policyVersion ||
    !Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 1 ||
    !Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 ||
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) throw new RuntimeFault('INVALID_REQUEST');
  const root = await realpath(options.root);
  const settings = Object.freeze({...options, root});
  const inside = (path: string) => {const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r));};
  async function checked(path: string, write = false) {
    const target = resolve(root, path);
    if (!inside(target)) throw new RuntimeFault('AUTHORITY_REQUIRED');
    let parent = root;
    const parts = relative(root, target).split('/').filter(Boolean);
    for (const [i, part] of parts.entries()) {
      parent = join(parent, part);
      try {const s = await lstat(parent); if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1))) throw new RuntimeFault('AUTHORITY_REQUIRED');}
      catch (e) {if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !write) throw e; if (i < parts.length - 1) await mkdir(parent);}
    }
    return target;
  }
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {const pending = tail.then(fn); tail = pending.catch(() => {}); return pending;};
  const live = (signal: AbortSignal) => {if (signal.aborted) throw new RuntimeFault('CANCELLED');};
  return {
    cwd: root, policyVersion: settings.policyVersion,
    resolvePath: async path => {const target = resolve(root, path); if (!inside(target)) throw new RuntimeFault('AUTHORITY_REQUIRED'); return target;},
    read: (path, signal) => exclusive(async () => {
      live(signal); const file = await open(await checked(path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new RuntimeFault('AUTHORITY_REQUIRED'); if (info.size > settings.maxFileBytes) throw new RuntimeFault('BUDGET_EXHAUSTED'); const bytes = await file.readFile(); live(signal); return bytes;} finally {await file.close();}
    }),
    write: (path, bytes, signal) => exclusive(async () => {
      live(signal); if (bytes.byteLength > settings.maxFileBytes) throw new RuntimeFault('BUDGET_EXHAUSTED');
      const file = await open(await checked(path, true), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      try {const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new RuntimeFault('AUTHORITY_REQUIRED'); await file.truncate(0); await file.writeFile(bytes); live(signal);} finally {await file.close();}
    }),
    stat: async (path, signal) => {live(signal); const target = await checked(path); const info = await lstat(target); return {path:target,name:basename(target),kind:info.isDirectory()?'directory':'file',size:info.size,modifiedAt:info.mtimeMs};},
    exec: (command, signal) => exclusive(async () => {
      live(signal);
      if (!settings.processes || process.platform !== 'darwin') throw new RuntimeFault('CAPABILITY_UNAVAILABLE');
      // No fork or network rules are granted. A command may replace the shell with exec,
      // but cannot create descendants that escape lifecycle supervision. System paths
      // contain executables/libraries, never home credentials.
      const quote = (s: string) => JSON.stringify(s);
      const ancestors: string[] = []; for (let p = dirname(root); ; p = dirname(p)) {ancestors.push(p); if (p === '/') break;}
      const profile = `(version 1)(deny default)(deny process-fork)(allow process-exec)(allow signal (target children))(allow sysctl-read)
(allow file-read* ${ancestors.map(p => `(literal ${quote(p)})`).join(' ')} (subpath "/System/Library") (subpath "/usr/lib") (subpath "/bin") (subpath "/usr/bin") (literal "/dev/null") (subpath ${quote(root)}))
(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))`;
      return new Promise((resolveResult, reject) => {
        const child = spawn('/usr/bin/sandbox-exec', ['-p',profile,'/bin/bash','--noprofile','--norc','-c',`ulimit -S -f ${Math.max(1,Math.floor(settings.maxFileBytes/512))} && ulimit -H -f ${Math.max(1,Math.floor(settings.maxFileBytes/512))} && ulimit -S -t ${Math.max(1,Math.ceil(settings.timeoutMs/1000))} && ulimit -H -t ${Math.max(1,Math.ceil(settings.timeoutMs/1000))} || exit 125;\n${command}`],
          {cwd:root,detached:true,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root},stdio:['ignore','pipe','pipe']});
        let size = 0, output = '', failure: RuntimeFault | undefined;
        const kill = () => {try {if(child.pid)process.kill(-child.pid,'SIGKILL');} catch {}};
        const stop = (reason: 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'BUDGET_EXHAUSTED') => {failure ??= new RuntimeFault(reason);kill();};
        const cancel = () => stop('CANCELLED');
        signal.addEventListener('abort',cancel,{once:true});
        const timer = setTimeout(()=>stop('DEADLINE_EXCEEDED'),settings.timeoutMs);
        const collect = (chunk:Buffer) => {size += chunk.length;if(size > settings.maxOutputBytes)stop('BUDGET_EXHAUSTED');else output += chunk.toString('utf8');};
        child.stdout.on('data',collect);child.stderr.on('data',collect);
        child.on('error',()=>{failure ??= new RuntimeFault('CAPABILITY_UNAVAILABLE');});
        child.on('close',code=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);kill();
          if(failure)reject(failure);
          else if(output.includes('sandbox_apply: Operation not permitted'))reject(new RuntimeFault('CAPABILITY_UNAVAILABLE'));
          else resolveResult({output,exitCode:code ?? 1});});
        if(signal.aborted)cancel();
      });
    }),
  };
}

// Verify captured browser observations, not a replacement for fresh UI execution.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const root = new URL("../", import.meta.url);
const evidence = JSON.parse(await readFile(new URL("artifacts/configuration-ui-v0.1/output/playwright/checks.json", root), "utf8"));
const observations = new Map(evidence.checks.map((entry) => [entry.check, entry]));
const get = (name) => { const observation = observations.get(name); assert.ok(observation, name); return observation; };
assert.equal(get("生效引用禁止直接禁用").enabled, "true");
assert.match(get("生效引用禁止直接禁用").text, /生效配置引用/);
assert.match(get("无备用拒绝生效且保留v1").error, /至少一个备用/);
assert.match(get("无备用拒绝生效且保留v1").active, /生效 v1/);
const ordering = get("键盘排序和工具能力拒绝");
assert.ok(ordering.fallbacks.startsWith("1\n文本模型"));
assert.match(ordering.error, /未声明工具调用能力/);
assert.equal(ordering.candidateLabels, "选择备用模型");
assert.match(get("同Provider模型ID重复拒绝").error, /相同模型 ID/);
const isolation = get("编辑令检查失效，生效快照不变");
assert.match(isolation.draft, /调整草稿/);
assert.doesNotMatch(isolation.active, /调整草稿/);
assert.doesNotMatch(isolation.draft, /模拟通过/);
assert.match(get("非回环HTTP地址拒绝").error, /HTTPS/);
assert.notEqual(get("非回环HTTP地址拒绝").responsesDisabled, null);
assert.match(get("添加自定义Provider及模型，模拟凭据设置").text, /synthetic-c-model/);
assert.match(get("添加自定义Provider及模型，模拟凭据设置").text, /模拟已设置/);
assert.equal(get("ESC关闭模型弹窗").dialogOpen, null);
for (const width of [320, 768]) {
  const observed = get(width + "px响应式无横向溢出");
  assert.equal(observed.width, width);
  assert.equal(observed.scroll, width);
}
assert.match(get("刷新恢复空态").providers, /第一个模型来源/);
assert.match(get("刷新恢复空态").active, /尚无生效/);
assert.match(get("空配置被拒绝").notice, /未生效/);
assert.match(get("保存草稿不生效").active, /尚无生效/);
assert.match(get("保存草稿不生效").notice, /未生效/);
const html = await readFile(new URL("prototypes/model-settings-v0.1/index.html", root), "utf8");
const js = await readFile(new URL("prototypes/model-settings-v0.1/app.js", root), "utf8");
assert.match(html, /connect-src 'none'/);
assert.doesNotMatch(html, /<input[^>]*type="password"/);
assert.doesNotMatch(js, /\b(localStorage|indexedDB|fetch|XMLHttpRequest|WebSocket)\s*[.(]/);
assert.doesNotMatch(js, /@earendil-works|apiKey/);
const baseline = JSON.parse(await readFile(new URL("artifacts/bootstrap/evidence-manifest.json", root), "utf8"));
let checked = 0;
for (const file of baseline.files) {
  const bytes = await readFile(new URL(file.path, root));
  assert.equal(bytes.length, file.byteLength, file.path + " length changed");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path + " changed");
  checked++;
}
console.log("PASS: " + evidence.checks.length + " captured UI observations and static prototype isolation checks.");
console.log("PASS: all " + checked + " bootstrap manifest entries unchanged.");
console.log("LIMIT: evidence assertions validate captured observations; no real Provider or final React UI exercised.");

/**
 * 浏览器端登录与发布验收：
 * 1. CDP 打开 /edit/（未登录）→ 点发布 → 应自动跳 /login
 * 2. 在登录页填账号密码提交 → 应回到 /edit/ 且徽标显示已登录
 * 3. 再点发布 → toast 提示已写入服务器
 */
const { launch } = require('./lib/cdp.js');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOT = p => path.join(__dirname, '..', 'preview', p);
/* 测试账号：默认用本地开发口令，可用环境变量覆盖（开源仓库不写死密码） */
const TEST_USER = process.env.KY_TEST_USER || 'kongyu';
const TEST_PASS = process.env.KY_TEST_PASS || 'kongyu2026';

(async () => {
  const b = await launch();
  await b.viewport(1440, 1000);

  /* --- 0. 先清掉旧会话：logout --- */
  await b.goto('http://127.0.0.1:6888/index.html');
  await b.eval(`fetch('api/logout',{method:'POST'}).catch(()=>{})`);
  await sleep(300);

  /* --- 1. 进后台，点发布（此时未登录）--- */
  await b.goto('http://127.0.0.1:6888/edit/');
  await sleep(2500); // 等探测完成
  const badge1 = await b.eval(`document.getElementById('modeBadge').textContent`);
  console.log('1a 未登录徽标:', badge1);

  await b.eval(`document.getElementById('fTitle').value='验收：登录与实时发布';
                document.getElementById('fTags').value='验收';
                document.getElementById('fSummary').value='CDP 自动验收产生的文章';
                var ta=document.getElementById('editor');
                ta.value='## 验收\\n\\n这篇文章由无头浏览器在 ' + new Date().toISOString() + ' 发布。';
                ta.dispatchEvent(new Event('input'));
                document.getElementById('btnPublish').click();`);
  await sleep(2500);
  const url1 = await b.eval(`location.pathname`);
  console.log('1b 点发布后跳转路径:', url1, url1.includes('/login') ? '→ 登录门禁生效' : '→ 异常：没跳登录');
  await b.shot(SHOT('14-login-gate.png'));

  /* --- 2. 填表单登录 --- */
  await b.eval(`document.getElementById('user').value='${TEST_USER}';
                document.getElementById('pass').value='${TEST_PASS}';
                document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true}));`);
  await sleep(2500);
  const url2 = await b.eval(`location.pathname`);
  console.log('2a 登录后路径:', url2, url2.includes('/edit') ? '→ 回跳后台生效' : '→ 异常：没回跳');
  const badge2 = await b.eval(`document.getElementById('modeBadge').textContent`);
  const logoutBtn = await b.eval(`var b=document.getElementById('btnLogout'); b.hidden ? '隐藏' : b.textContent`);
  console.log('2b 后台徽标:', badge2, '| 退出按钮:', logoutBtn);
  await b.shot(SHOT('15-edit-logged.png'));

  /* --- 3. 登录后再发布（页面回跳后表单是空的，重新填一遍）--- */
  await b.eval(`document.getElementById('fTitle').value='验收：登录与实时发布';
                document.getElementById('fTags').value='验收';
                document.getElementById('fSummary').value='CDP 自动验收产生的文章';
                var ta=document.getElementById('editor');
                ta.value='## 验收\\n\\n这篇文章由无头浏览器在登录成功后发布，验证会话写路径。';
                ta.dispatchEvent(new Event('input'));
                document.getElementById('btnPublish').click();`);
  await sleep(2000);
  const toast = await b.eval(`var t=document.querySelector('.toast'); t ? t.textContent : '（无 toast）'`);
  console.log('3a 发布 toast:', toast);
  const count = await b.eval(`document.getElementById('countPub').textContent`);
  console.log('3b 已发布数:', count);

  /* --- 4. 清理：删掉验收文章（绝对路径，避免 /edit/ 页面相对路径歧义）--- */
  const del = await b.eval(`(async () => {
    const r = await fetch('/api/posts/' + encodeURIComponent(KY.store.slugify('验收：登录与实时发布')), {method:'DELETE',credentials:'same-origin'});
    return r.status + ' ' + (await r.text()).slice(0,40);
  })()`);
  console.log('4a 删除验收文章 →', del);
  await b.close();
  console.log('\n浏览器端验收完成');
})().catch(e => { console.error('验收失败:', e.message); process.exit(1); });

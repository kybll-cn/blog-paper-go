/**
 * 验收：上传 + 下载卡片 + 站点设置面板（浏览器实拍）
 */
const { launch } = require('./lib/cdp.js');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* 截图输出目录：相对仓库根，clone 到哪儿都能跑 */
const SHOT = p => path.join(__dirname, '..', 'preview', p);
/* 测试账号：默认用本地开发口令，可用环境变量覆盖（开源仓库不写死密码） */
const TEST_USER = process.env.KY_TEST_USER || 'kongyu';
const TEST_PASS = process.env.KY_TEST_PASS || 'kongyu2026';
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

(async () => {
  const b = await launch();
  await b.viewport(1440, 1000);

  /* 1. 登录 */
  await b.goto('http://127.0.0.1:6888/login');
  await sleep(800);
  await b.eval(`document.getElementById('user').value='${TEST_USER}';
                document.getElementById('pass').value='${TEST_PASS}';
                document.getElementById('loginForm').dispatchEvent(new Event('submit',{cancelable:true}));`);
  await sleep(2500);

  /* 2. 真上传一张图（内置最小 PNG，不依赖仓库外素材） */
  await b.goto('http://127.0.0.1:6888/edit/');
  await sleep(2500);
  await b.eval(`window.__pngB64 = ${JSON.stringify(TINY_PNG.toString('base64'))};`);
  const up = await b.evalJson(`(async () => {
    const bin = atob(window.__pngB64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const fd = new FormData();
    fd.append('file', new File([buf], '验收图.png', { type: 'image/png' }));
    const r = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
    return { status: r.status, json: await r.json() };
  })()`);
  console.log('2a 真上传:', JSON.stringify(up));
  const imgURL = up.json.url;

  /* 3. 发布带图片 + 附件卡片的文章 */
  await b.eval(`document.getElementById('fTitle').value='附件下载演示';
                document.getElementById('fTags').value='演示';
                document.getElementById('fSummary').value='下载卡片与图片渲染验收';
                var ta=document.getElementById('editor');
                ta.value='## 下载卡片\\n\\n[测试手册.pdf](/uploads/202609/demo.pdf)\\n\\n![验收图](${imgURL})\\n\\n正文结束。';
                ta.dispatchEvent(new Event('input'));
                document.getElementById('btnPublish').click();`);
  await sleep(2500);
  console.log('3a 发布 toast:', await b.eval(`var t=document.querySelector('.toast');t?t.textContent:'-'`));

  /* 4. 打开文章页看卡片与图片 */
  await b.goto('http://127.0.0.1:6888/p/%E9%99%84%E4%BB%B6%E4%B8%8B%E8%BD%BD%E6%BC%94%E7%A4%BA');
  await sleep(2500);
  console.log('4a 下载卡片:', await b.eval(`var c=document.querySelector('.dl-card'); c ? c.innerText.replace(/\\n/g,' | ') : '无卡片'`));
  console.log('4b 图片 src 可达:', await b.eval(`(async()=>{var img=document.querySelector('.prose img');if(!img)return '无图';var r=await fetch(img.getAttribute('src'));return r.status+' '+r.headers.get('content-type')})()`));
  await b.eval(`document.querySelector('.dl-toggle') && document.querySelector('.dl-toggle').click()`);
  await sleep(300);
  console.log('4c 直链展开:', await b.eval(`!!document.querySelector('.dl-card.is-open')`));
  await b.eval(`document.querySelector('.dl-card').scrollIntoView({block:'center'})`);
  await b.shot(SHOT('19-dl-card.png'));

  /* 5. 站点设置面板 */
  await b.goto('http://127.0.0.1:6888/edit/');
  await sleep(2500);
  await b.eval(`document.getElementById('btnSettings').click()`);
  await sleep(800);
  console.log('5a 面板可见:', await b.eval(`!document.getElementById('settingsPanel').hidden`));
  console.log('5b 回填 ICP:', await b.eval(`document.getElementById('stIcp').value`));
  await b.shot(SHOT('20-settings.png'));

  /* 6. 清理 */
  await b.eval(`fetch('/api/posts/'+encodeURIComponent('附件下载演示'),{method:'DELETE',credentials:'same-origin'})`);
  const del = await b.evalJson(`(async()=>{var r=await fetch('/api/posts/'+encodeURIComponent('附件下载演示'),{method:'DELETE',credentials:'same-origin'});return r.status})()`);
  console.log('6a 清理测试文章 →', del);
  await b.close();
  console.log('验收完成');
})().catch(e => { console.error('验收失败:', e.message); process.exit(1); });

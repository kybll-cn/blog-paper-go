/** 验收：公安备案号在页脚与设置面板的显示 */
const { launch } = require('./lib/cdp.js');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SHOT = p => path.join(__dirname, '..', 'preview', p);
(async () => {
  const b = await launch();
  await b.viewport(1440, 1000);
  await b.goto('http://127.0.0.1:8080/');
  await sleep(2500);
  console.log('=== 页脚文本 ===');
  console.log(await b.eval(`document.querySelector('body > footer').innerText`));
  console.log('=== 公安备案链接 href ===');
  console.log(await b.eval(`(function(){
    var a = [].slice.call(document.querySelectorAll('body > footer a'));
    var p = a.filter(function(x){ return /公安|beian\\.mps/.test(x.textContent + x.href); })[0];
    return p ? p.href : '无';
  })()`));
  await b.eval(`document.querySelector('body > footer').scrollIntoView()`);
  await b.shot(SHOT('21-footer-police.png'));

  await b.goto('http://127.0.0.1:8080/edit/');
  await sleep(2500);
  await b.eval(`document.getElementById('btnSettings').click()`);
  await sleep(800);
  console.log('=== 设置面板公安备案回填 ===');
  console.log(await b.eval(`document.getElementById('stPolice').value`));
  await b.shot(SHOT('22-settings-police.png'));
  await b.close();
})().catch(e => { console.error('失败:', e.message); process.exit(1); });

/**
 * 后台加载性能探针：用 CDP 精确测量 /edit/ 的加载时间线
 * 输出：导航耗时、每个资源的耗时排行、store.js 探测完成时刻
 */
const { launch } = require('./lib/cdp.js');

(async () => {
  const b = await launch();
  await b.viewport(1440, 900);

  for (const url of [
    'http://127.0.0.1:8080/edit/',
    'http://127.0.0.1:8080/index.html',
  ]) {
    console.log('\n========== ' + url + ' ==========');
    const t0 = Date.now();
    await b.goto(url);
    const wall = Date.now() - t0;

    // 导航计时 + 资源计时
    const data = await b.evalJson(`(function(){
      var n = performance.getEntriesByType('navigation')[0];
      var res = performance.getEntriesByType('resource').map(function(r){
        return { name: r.name.split('/').slice(-2).join('/'),
                 dur: Math.round(r.duration),
                 wait: Math.round(r.responseStart - r.requestStart),
                 size: r.transferSize };
      }).sort(function(a,b){ return b.dur - a.dur; });
      var paint = performance.getEntriesByType('paint').map(function(p){
        return { name: p.name, at: Math.round(p.startTime) };
      });
      return {
        dns: Math.round(n.domainLookupEnd - n.domainLookupStart),
        tcp: Math.round(n.connectEnd - n.connectStart),
        ttfb: Math.round(n.responseStart - n.requestStart),
        domReady: Math.round(n.domContentLoadedEventEnd),
        load: Math.round(n.loadEventEnd),
        paint: paint,
        slowest: res.slice(0, 8),
        count: res.length
      };
    })()`);
    console.log('墙钟总耗时:', wall + 'ms');
    console.log('DNS:', data.dns + 'ms · TCP:', data.tcp + 'ms · TTFB:', data.ttfb + 'ms');
    console.log('DOMContentLoaded:', data.domReady + 'ms · load:', data.load + 'ms');
    console.log('首次绘制:', JSON.stringify(data.paint));
    console.log('资源数:', data.count, '· 最慢的 8 个：');
    data.slowest.forEach(r => console.log('  ' + String(r.dur).padStart(5) + 'ms  等' + String(r.wait).padStart(5) + 'ms  ' + r.size + 'B  ' + r.name));

    // 等 store.js 探测完成，再测一次
    const probe = await b.evalJson(`(function(){
      return new Promise(function(resolve){
        var t0 = performance.now();
        KY.store.ready.then(function(isServer){
          resolve({ probeMs: Math.round(performance.now() - t0 + (window.__probeStart||0)),
                    isServer: isServer, sinceNav: Math.round(performance.now()) });
        });
        setTimeout(function(){ resolve({ probeMs: -1, isServer: null, sinceNav: -1 }); }, 10000);
      });
    })()`);
    console.log('探测 ready:', JSON.stringify(probe));
  }
  await b.close();
})().catch(e => { console.error('探针失败:', e.message); process.exit(1); });

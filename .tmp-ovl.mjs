import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9241');
const page = b.contexts()[0].pages()[0];
await page.setViewportSize({width:1024,height:700});
await page.getByRole('link', { name: 'Dinero real', exact: true }).click();
await page.waitForTimeout(1000);
console.log(await page.evaluate(() => {
  const res = [];
  for (const el of document.querySelectorAll('.main *')) {
    const kids = [...el.children].filter((k) => k.getBoundingClientRect().height > 0 && !['absolute','fixed'].includes(getComputedStyle(k).position));
    for (let i = 1; i < kids.length; i++) { const a = kids[i-1].getBoundingClientRect(), c = kids[i].getBoundingClientRect();
      if (c.top < a.bottom - 1 && c.left < a.right - 1 && c.right > a.left + 1 && c.bottom > a.top + 1) res.push(`${el.tagName}.${el.getAttribute('class')} :: ${kids[i-1].tagName}.${kids[i-1].getAttribute('class')} [${Math.round(a.top)}-${Math.round(a.bottom)} x ${Math.round(a.left)}-${Math.round(a.right)}] / ${kids[i].tagName}.${kids[i].getAttribute('class')} [${Math.round(c.top)}-${Math.round(c.bottom)} x ${Math.round(c.left)}-${Math.round(c.right)}]`); }
  }
  return res.join('\n');
}));
await b.close().catch(()=>{});

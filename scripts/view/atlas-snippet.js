// Show the painted leaf atlas full page (for a screenshot)
//   node scripts/probe.mjs --file scripts/view/atlas-snippet.js --width 1400 --height 1400 --screenshot out/atlas.png
const m = await import('/src/world/trees/textures.js');
const c = m.debugAtlasCanvas(71);
document.body.innerHTML = '';
document.body.style.margin = '0';
document.body.style.background = '#6a6a6a';
c.style.width = '1400px';
c.style.height = '1400px';
c.style.display = 'block';
document.body.appendChild(c);
await new Promise((r) => setTimeout(r, 400));
return { w: c.width, h: c.height };

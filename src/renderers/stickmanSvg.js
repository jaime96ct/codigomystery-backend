function esc(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const positions = {
  left: 300,
  center: 540,
  right: 780,
};

function inferSpec(prompt = '') {
  const p = prompt.toLowerCase();
  let setting = 'generic';
  if (p.includes('castle') || p.includes('medieval')) setting = p.includes('room') ? 'castle_room' : 'castle_courtyard';
  else if (p.includes('spaceship') || p.includes('space')) setting = 'spaceship';
  else if (p.includes('snow') || p.includes('cabin')) setting = 'snow_cabin';
  else if (p.includes('forest')) setting = 'forest';
  else if (p.includes('hospital')) setting = 'hospital';
  else if (p.includes('train')) setting = 'train';
  else if (p.includes('ship') || p.includes('boat')) setting = 'ship';
  else if (p.includes('street')) setting = 'street';
  else if (p.includes('house')) setting = 'house';

  const weather = p.includes('storm') ? 'storm'
    : p.includes('rain') ? 'rain'
    : p.includes('snow') ? 'snow'
    : 'none';

  const expression = p.includes('nervous') || p.includes('sweat') ? 'nervous'
    : p.includes('fear') ? 'fear'
    : p.includes('suspicious') ? 'suspicion'
    : p.includes('puzzled') ? 'surprise'
    : 'neutral';

  const characters = [
    { role: 'main', position: 'center', expression, pose: p.includes('point') ? 'point' : 'stand' },
  ];
  if (p.includes('another stickman') || p.includes('detective') || p.includes('fleeing') || p.includes('silhouette')) {
    characters[0].position = 'left';
    characters.push({
      role: p.includes('silhouette') || p.includes('fleeing') ? 'silhouette' : 'second',
      position: 'right',
      expression: p.includes('silhouette') ? 'neutral' : 'suspicion',
      pose: p.includes('fleeing') ? 'run' : p.includes('accus') ? 'accuse' : 'stand',
    });
  }

  const props = [];
  for (const [needle, prop] of [
    ['torch', 'torch'],
    ['pedestal', 'jewel_pedestal'],
    ['jewel', 'jewel_pedestal'],
    ['footprint', 'footprint'],
    ['door', 'door'],
    ['window', 'window'],
    ['note', 'note'],
    ['key', 'key'],
    ['screen', 'screen'],
    ['wall', 'wall'],
  ]) {
    if (p.includes(needle) && !props.includes(prop)) props.push(prop);
  }

  return { setting, weather, mood: 'mystery', characters, props, lighting: p.includes('dark') ? 'dark' : 'normal' };
}

function background(spec) {
  const dark = spec.lighting === 'dark';
  const sky = dark ? '#111522' : '#28324f';
  const floor = dark ? '#171821' : '#2d3040';

  if (spec.setting === 'spaceship') {
    return `
      <rect width="1080" height="1920" fill="#0d1220"/>
      <rect x="90" y="140" width="900" height="1350" rx="40" fill="#20283b" stroke="#59637e" stroke-width="12"/>
      <rect x="170" y="230" width="740" height="380" rx="34" fill="#070b13" stroke="#72809f" stroke-width="10"/>
      <circle cx="760" cy="370" r="54" fill="#dce8ff"/>
      <circle cx="420" cy="330" r="11" fill="#dce8ff"/><circle cx="510" cy="420" r="8" fill="#dce8ff"/>
      <rect x="155" y="1260" width="770" height="150" rx="25" fill="#111726"/>
      <circle cx="250" cy="1335" r="20" fill="#8ba8ff"/><circle cx="315" cy="1335" r="20" fill="#ffcf70"/>
    `;
  }
  if (spec.setting === 'castle_room') {
    return `
      <rect width="1080" height="1920" fill="#16151b"/>
      <rect x="0" y="0" width="1080" height="1500" fill="#2a2930"/>
      <path d="M0 300 H1080 M0 620 H1080 M0 940 H1080 M0 1260 H1080" stroke="#3c3a42" stroke-width="10"/>
      <path d="M180 0 V1500 M540 0 V1500 M900 0 V1500" stroke="#3c3a42" stroke-width="10"/>
      <rect y="1500" width="1080" height="420" fill="#19181f"/>
    `;
  }
  if (spec.setting === 'castle_courtyard') {
    return `
      <rect width="1080" height="1920" fill="${sky}"/>
      <rect x="0" y="580" width="1080" height="720" fill="#3a3941"/>
      <path d="M0 700 H1080 M0 980 H1080" stroke="#4d4b54" stroke-width="10"/>
      <path d="M230 580 V1300 M570 580 V1300 M900 580 V1300" stroke="#4d4b54" stroke-width="10"/>
      <rect y="1300" width="1080" height="620" fill="#1c1c24"/>
    `;
  }
  if (spec.setting === 'snow_cabin') {
    return `
      <rect width="1080" height="1920" fill="#27344e"/>
      <polygon points="120,850 540,480 960,850" fill="#4d3528"/>
      <rect x="210" y="820" width="660" height="570" fill="#6f4b35"/>
      <rect x="475" y="1030" width="180" height="360" fill="#2c201a"/>
      <rect y="1390" width="1080" height="530" fill="#e8edf5"/>
    `;
  }
  if (spec.setting === 'forest') {
    return `
      <rect width="1080" height="1920" fill="#16211d"/>
      ${[130,330,760,930].map(x => `<rect x="${x}" y="400" width="70" height="1100" fill="#33281f"/><circle cx="${x+35}" cy="420" r="180" fill="#1f3a2d"/>`).join('')}
      <rect y="1450" width="1080" height="470" fill="#18231c"/>
    `;
  }
  return `
    <rect width="1080" height="1920" fill="${sky}"/>
    <rect y="1320" width="1080" height="600" fill="${floor}"/>
    <rect x="110" y="250" width="860" height="870" rx="30" fill="#242632" stroke="#3b3d4a" stroke-width="10"/>
  `;
}

function weather(spec) {
  if (spec.weather === 'rain' || spec.weather === 'storm') {
    const drops = Array.from({ length: 34 }, (_, i) => {
      const x = (i * 97) % 1080;
      const y = (i * 151) % 1450;
      return `<line x1="${x}" y1="${y}" x2="${x-28}" y2="${y+90}" stroke="#8db4d8" stroke-width="7" opacity=".65"/>`;
    }).join('');
    const flash = spec.weather === 'storm' ? '<path d="M820 40 L720 280 L805 280 L680 540" fill="none" stroke="#fff5a5" stroke-width="28"/>' : '';
    return drops + flash;
  }
  if (spec.weather === 'snow') {
    return Array.from({ length: 42 }, (_, i) => {
      const x = (i * 89) % 1080;
      const y = (i * 137) % 1500;
      const r = 5 + (i % 4) * 3;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#f4f8ff" opacity=".8"/>`;
    }).join('');
  }
  return '';
}

function expressionFace(x, y, expression, silhouette = false) {
  if (silhouette) return '';
  const mouth = expression === 'fear' || expression === 'surprise'
    ? `<circle cx="${x}" cy="${y+28}" r="18" fill="#101015"/>`
    : expression === 'nervous'
    ? `<path d="M${x-30} ${y+34} Q${x} ${y+18} ${x+30} ${y+34}" fill="none" stroke="#101015" stroke-width="11"/><path d="M${x+82} ${y-10} q25 35 0 70 q-25-35 0-70" fill="#69b8ff"/>`
    : expression === 'angry'
    ? `<path d="M${x-30} ${y+30} Q${x} ${y+12} ${x+30} ${y+30}" fill="none" stroke="#101015" stroke-width="11"/>`
    : `<path d="M${x-28} ${y+25} Q${x} ${y+42} ${x+28} ${y+25}" fill="none" stroke="#101015" stroke-width="10"/>`;

  const brows = expression === 'suspicion' || expression === 'angry'
    ? `<path d="M${x-62} ${y-45} L${x-22} ${y-58}" stroke="#101015" stroke-width="10"/><path d="M${x+20} ${y-58} L${x+60} ${y-45}" stroke="#101015" stroke-width="10"/>`
    : '';

  return `
    <circle cx="${x-38}" cy="${y-18}" r="13" fill="#101015"/>
    <circle cx="${x+38}" cy="${y-18}" r="13" fill="#101015"/>
    ${brows}
    ${mouth}
  `;
}

function character(c, index) {
  const x = positions[c.position] ?? (index === 0 ? 430 : 700);
  const y = 1040;
  const silhouette = c.role === 'silhouette';
  const stroke = silhouette ? '#050507' : '#0a0a0e';
  const headFill = silhouette ? '#050507' : '#f7f7f8';
  const pose = c.pose || 'stand';

  const arms = pose === 'point' || pose === 'accuse'
    ? `<line x1="${x}" y1="${y+210}" x2="${x+170}" y2="${y+130}" stroke="${stroke}" stroke-width="28" stroke-linecap="round"/>
       <line x1="${x}" y1="${y+215}" x2="${x-105}" y2="${y+320}" stroke="${stroke}" stroke-width="28" stroke-linecap="round"/>`
    : pose === 'run'
    ? `<line x1="${x}" y1="${y+210}" x2="${x+125}" y2="${y+120}" stroke="${stroke}" stroke-width="28" stroke-linecap="round"/>
       <line x1="${x}" y1="${y+215}" x2="${x-115}" y2="${y+135}" stroke="${stroke}" stroke-width="28" stroke-linecap="round"/>`
    : `<line x1="${x}" y1="${y+210}" x2="${x+110}" y2="${y+300}" stroke="${stroke}" stroke-width="28" stroke-linecap="round"/>
       <line x1="${x}" y1="${y+210}" x2="${x-110}" y2="${y+300}" stroke="${stroke}" stroke-width="28" stroke-linecap="round"/>`;

  const legs = pose === 'run'
    ? `<line x1="${x}" y1="${y+470}" x2="${x+125}" y2="${y+625}" stroke="${stroke}" stroke-width="30" stroke-linecap="round"/>
       <line x1="${x}" y1="${y+470}" x2="${x-120}" y2="${y+560}" stroke="${stroke}" stroke-width="30" stroke-linecap="round"/>`
    : `<line x1="${x}" y1="${y+470}" x2="${x+90}" y2="${y+650}" stroke="${stroke}" stroke-width="30" stroke-linecap="round"/>
       <line x1="${x}" y1="${y+470}" x2="${x-90}" y2="${y+650}" stroke="${stroke}" stroke-width="30" stroke-linecap="round"/>`;

  return `
    <g>
      <circle cx="${x}" cy="${y}" r="120" fill="${headFill}" stroke="${stroke}" stroke-width="24"/>
      ${expressionFace(x, y, c.expression || 'neutral', silhouette)}
      <line x1="${x}" y1="${y+120}" x2="${x}" y2="${y+470}" stroke="${stroke}" stroke-width="32" stroke-linecap="round"/>
      ${arms}
      ${legs}
    </g>
  `;
}

function prop(name, index) {
  const x = 160 + (index * 180) % 760;
  if (name === 'torch') return `<g transform="translate(${x} 900)"><line x1="0" y1="0" x2="0" y2="230" stroke="#3b2418" stroke-width="26"/><path d="M0 0 C-55-75 -20-155 0-190 C30-145 55-80 0 0" fill="#f0a13a"/><path d="M0 -25 C-28-75 -5-110 4-132 C18-100 30-55 0-25" fill="#ffe38a"/></g>`;
  if (name === 'jewel_pedestal') return `<g transform="translate(540 1120)"><rect x="-115" y="0" width="230" height="260" rx="20" fill="#696b75"/><polygon points="0,-95 70,-20 0,55 -70,-20" fill="#7ed7ff" stroke="#d8f5ff" stroke-width="10"/></g>`;
  if (name === 'footprint') return `<g transform="translate(${x} 1510) rotate(-18)"><ellipse cx="0" cy="0" rx="46" ry="92" fill="#6e7785"/><circle cx="-30" cy="-95" r="16" fill="#6e7785"/><circle cx="0" cy="-110" r="17" fill="#6e7785"/><circle cx="30" cy="-95" r="15" fill="#6e7785"/></g>`;
  if (name === 'door') return `<rect x="${x}" y="760" width="260" height="620" rx="18" fill="#4f3527" stroke="#211711" stroke-width="16"/><circle cx="${x+210}" cy="1080" r="18" fill="#e2b65e"/>`;
  if (name === 'window') return `<rect x="${x}" y="520" width="300" height="360" fill="#192b44" stroke="#6a6d77" stroke-width="18"/><line x1="${x+150}" y1="520" x2="${x+150}" y2="880" stroke="#6a6d77" stroke-width="12"/>`;
  if (name === 'note') return `<g transform="translate(${x} 1280) rotate(-8)"><rect width="220" height="170" fill="#f1e7c9"/><line x1="30" y1="55" x2="185" y2="55" stroke="#756b5a" stroke-width="8"/><line x1="30" y1="95" x2="160" y2="95" stroke="#756b5a" stroke-width="8"/></g>`;
  if (name === 'key') return `<g transform="translate(${x} 1320)"><circle cx="0" cy="0" r="45" fill="none" stroke="#d6b04f" stroke-width="20"/><line x1="45" y1="0" x2="180" y2="0" stroke="#d6b04f" stroke-width="20"/><line x1="150" y1="0" x2="150" y2="55" stroke="#d6b04f" stroke-width="20"/></g>`;
  if (name === 'screen') return `<rect x="${x}" y="650" width="330" height="230" rx="18" fill="#0b1722" stroke="#6f85a8" stroke-width="16"/><circle cx="${x+80}" cy="760" r="18" fill="#63d8a1"/>`;
  if (name === 'wall') return `<rect x="70" y="650" width="940" height="80" fill="#4b4a52"/>`;
  return '';
}

export function renderStickmanSvg({ prompt = '', visualSpec = null, sceneNumber = 1 } = {}) {
  const spec = visualSpec && typeof visualSpec === 'object'
    ? { ...inferSpec(prompt), ...visualSpec }
    : inferSpec(prompt);

  const characters = Array.isArray(spec.characters) && spec.characters.length
    ? spec.characters.slice(0, 3)
    : inferSpec(prompt).characters;

  const props = Array.isArray(spec.props) ? spec.props.slice(0, 5) : [];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
    <defs>
      <filter id="shadow"><feDropShadow dx="0" dy="18" stdDeviation="18" flood-opacity=".28"/></filter>
    </defs>
    ${background(spec)}
    ${weather(spec)}
    <g filter="url(#shadow)">
      ${props.map(prop).join('')}
      ${characters.map(character).join('')}
    </g>
    <rect x="40" y="40" width="1000" height="1840" rx="54" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="5"/>
    <metadata>CodigoMystery scene ${esc(sceneNumber)}</metadata>
  </svg>`;
}

/* 内置桌面宠物角色（自绘 SVG，无外部素材、无版权依赖）
 * 每个角色：{ name, render(): string } —— render 返回 SVG 片段，外层容器按状态加 class 做动画。
 */
window.PET_CHARACTERS = (function () {
  function fox() {
    return `
      <ellipse cx="62" cy="104" rx="30" ry="7" fill="rgba(0,0,0,0.10)"/>
      <path d="M40 34 L33 12 L54 24 Z" fill="#E8843C"/>
      <path d="M80 34 L87 12 L66 24 Z" fill="#E8843C"/>
      <path d="M33 16 L37 27 L46 27 Z" fill="#FBD9C0"/>
      <path d="M87 16 L83 27 L74 27 Z" fill="#FBD9C0"/>
      <circle cx="60" cy="46" r="28" fill="#F08A3C"/>
      <path d="M60 30 q-20 4 -22 22 q10 14 22 14 q12 0 22 -14 q-2 -18 -22 -22 Z" fill="#FBD9C0"/>
      <ellipse cx="60" cy="62" rx="26" ry="16" fill="#F08A3C"/>
      <ellipse cx="60" cy="66" rx="14" ry="10" fill="#FBEBDC"/>
      <circle cx="50" cy="44" r="3.6" fill="#3A2A1E"/>
      <circle cx="70" cy="44" r="3.6" fill="#3A2A1E"/>
      <ellipse cx="60" cy="55" rx="4.6" ry="3.2" fill="#3A2A1E"/>
      <path d="M52 60 q8 7 16 0" stroke="#3A2A1E" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M86 74 q22 6 10 26 q-4 6 -12 2 q-6 -4 -2 -10 q4 -8 -8 -12 Z" fill="#F08A3C"/>
      <path d="M92 96 q6 4 6 12" stroke="#FBD9C0" stroke-width="8" fill="none" stroke-linecap="round"/>
    `;
  }

  function bot() {
    return `
      <ellipse cx="60" cy="104" rx="28" ry="7" fill="rgba(0,0,0,0.10)"/>
      <rect x="52" y="8" width="16" height="14" rx="4" fill="#7C8AA0"/>
      <circle cx="60" cy="6" r="6" fill="#4F7CF7"/>
      <rect x="26" y="26" width="68" height="50" rx="16" fill="#E7ECF5" stroke="#B7C2D4" stroke-width="2"/>
      <rect x="38" y="38" width="44" height="22" rx="8" fill="#2B3446"/>
      <circle cx="52" cy="49" r="4.6" fill="#7CE0FF"/>
      <circle cx="68" cy="49" r="4.6" fill="#7CE0FF"/>
      <rect x="48" y="66" width="24" height="4" rx="2" fill="#B7C2D4"/>
      <rect x="34" y="78" width="52" height="20" rx="10" fill="#DCE4F2" stroke="#B7C2D4" stroke-width="2"/>
      <circle cx="48" cy="88" r="3.4" fill="#4F7CF7"/>
      <circle cx="60" cy="88" r="3.4" fill="#8B97AD"/>
      <circle cx="72" cy="88" r="3.4" fill="#4F7CF7"/>
    `;
  }

  function cat() {
    return `
      <ellipse cx="60" cy="104" rx="28" ry="7" fill="rgba(0,0,0,0.10)"/>
      <path d="M34 40 L30 14 L52 28 Z" fill="#9AA3B2"/>
      <path d="M86 40 L90 14 L68 28 Z" fill="#9AA3B2"/>
      <path d="M34 20 L37 30 L45 30 Z" fill="#F3C7D6"/>
      <path d="M86 20 L83 30 L75 30 Z" fill="#F3C7D6"/>
      <circle cx="60" cy="48" r="28" fill="#B4BCCB"/>
      <ellipse cx="60" cy="66" rx="24" ry="14" fill="#C6CDD9"/>
      <ellipse cx="50" cy="44" rx="4" ry="5" fill="#2F3542"/>
      <ellipse cx="70" cy="44" rx="4" ry="5" fill="#2F3542"/>
      <path d="M60 54 l-4 4 h8 Z" fill="#F3C7D6"/>
      <path d="M56 60 q4 4 8 0" stroke="#2F3542" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      <path d="M32 56 h-14 M32 62 l-14 4 M88 56 h14 M88 62 l14 4" stroke="#8B97AD" stroke-width="1.6" stroke-linecap="round"/>
    `;
  }

  function ghost() {
    return `
      <ellipse cx="60" cy="104" rx="26" ry="6" fill="rgba(0,0,0,0.10)"/>
      <path d="M28 96 q0 -56 32 -56 q32 0 32 56 l-8 -6 -8 6 -8 -6 -8 6 -8 -6 -8 6 Z" fill="#F4F6FB" stroke="#D6DCEA" stroke-width="2"/>
      <circle cx="48" cy="60" r="5" fill="#3B4256"/>
      <circle cx="72" cy="60" r="5" fill="#3B4256"/>
      <path d="M52 76 q8 8 16 0" stroke="#3B4256" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      <circle cx="36" cy="72" r="4" fill="#FFC7DA" opacity="0.8"/>
      <circle cx="84" cy="72" r="4" fill="#FFC7DA" opacity="0.8"/>
    `;
  }

  return {
    fox: { name: '小狐狸', render: fox },
    bot: { name: '小机器人', render: bot },
    cat: { name: '小猫', render: cat },
    ghost: { name: '小幽灵', render: ghost },
  };
})();

// 支持扫描/替换的文件扩展名（小写、不含点）
// 覆盖 Office 全系列 + 常见文本类格式
const OFFICE_EXTS = [
  // Word
  'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm',
  // PowerPoint
  'ppt', 'pptx', 'pptm', 'pps', 'ppsx', 'ppsm', 'pot', 'potx', 'potm',
  // Excel
  'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm',
  // 其他办公
  'rtf', 'odt', 'ods', 'odp', 'csv',
];

const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js',
  'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go',
  'rs', 'rb', 'php', 'swift', 'kt', 'sql', 'sh', 'bat', 'ini', 'conf',
  'cfg', 'yaml', 'yml', 'toml', 'log', 'tex', 'vue',
];

// 文本类扩展名：可以安全地按纯文本读写替换
const PLAIN_TEXT_SAFE = new Set([...TEXT_EXTS, 'csv', 'rtf', 'tex', 'xml', 'json']);

// 所有可选类型（界面筛选用）
const ALL_EXTS = [...OFFICE_EXTS, ...TEXT_EXTS];

// Office 二进制/压缩格式，不能直接当纯文本替换，需要解包 XML
const ZIP_BASED_OFFICE = new Set([
  'docx', 'docm', 'dotx', 'dotm',
  'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm',
  'xlsx', 'xlsm', 'xlsb', 'xltx', 'xltm',
]);

module.exports = { ALL_EXTS, OFFICE_EXTS, TEXT_EXTS, PLAIN_TEXT_SAFE, ZIP_BASED_OFFICE };

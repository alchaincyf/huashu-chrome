// Small, dependency-free message catalogs for terminal and installation pages.
export function normalizeLocale(value) {
  return /^zh(?:[-_]|$)/i.test(String(value || '')) ? 'zh-CN' : 'en';
}

export function resolveLocale({ lang, env = process.env, systemLocale = Intl.DateTimeFormat().resolvedOptions().locale } = {}) {
  return normalizeLocale(lang || env.HUASHU_CHROME_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || systemLocale);
}

export function parseLanguageArgs(argv, options = {}) {
  const args = [];
  let lang;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang' || argv[i].startsWith('--lang=')) {
      lang = argv[i] === '--lang' ? argv[++i] : argv[i].slice(7);
      if (!lang || !/^(en(?:[-_]\w+)*|zh(?:[-_]\w+)*)$/i.test(lang)) {
        throw new Error('--lang requires en or zh-CN');
      }
    } else {
      args.push(argv[i]);
    }
  }
  return { args, locale: resolveLocale({ ...options, lang }) };
}

export function createTranslator(catalog, locale = resolveLocale()) {
  const selected = catalog[normalizeLocale(locale)] || catalog.en;
  return (key, values = {}) => {
    const message = selected?.[key] ?? catalog.en?.[key];
    if (message == null) throw new Error(`Missing translation: ${key}`);
    return String(message).replace(/\{([a-zA-Z][\w]*)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  };
}

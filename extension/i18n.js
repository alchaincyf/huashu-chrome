// Shared UI localization helpers for extension pages.

export function t(key, substitutions) {
  const messageKey = key.startsWith('ui_') ? key : `ui_${key}`;
  return chrome.i18n.getMessage(messageKey, substitutions);
}

export function localizeDocument(root = document) {
  const locale = t('document_language') || 'en';
  root.documentElement.lang = locale.replaceAll('_', '-');

  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.dataset.i18n);
  }

  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.getAttributeNames()) {
      if (!attribute.startsWith('data-i18n-')) continue;
      const targetAttribute = attribute.slice('data-i18n-'.length);
      element.setAttribute(targetAttribute, t(element.getAttribute(attribute)));
    }
  }
}

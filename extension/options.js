import { localizeDocument, t } from './i18n.js';
import { renderGrantRows } from './handoff/rows.js';

localizeDocument();
renderGrantRows(document.getElementById('grants'), t);

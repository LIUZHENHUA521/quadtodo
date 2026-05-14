import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { resources, type SupportedLng } from './resources'

export const LANG_STORAGE_KEY = 'quadtodo.lang'

function readInitialLang(): SupportedLng {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY)
    if (saved && saved in resources) return saved as SupportedLng
  } catch {}
  return 'zh-CN'
}

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: readInitialLang(),
    fallbackLng: 'zh-CN',
    defaultNS: 'common',
    ns: ['common', 'palette', 'topbar', 'todo', 'session', 'transcript', 'wiki', 'settings', 'errors'],
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  })

export default i18n

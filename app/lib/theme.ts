const THEMES: Record<string, string> = {
  gold: '#C9A227',
  blue: '#1565C0',
  green: '#2E7D32',
  grey: '#546E7A',
  red: '#B71C1C',
}

export function getThemeColor(): string {
  if (typeof window === 'undefined') return '#C9A227'
  const theme = localStorage.getItem('company_theme') || 'gold'
  return THEMES[theme] || '#C9A227'
}

export function applyTheme(): void {
  const color = getThemeColor()
  document.documentElement.style.setProperty('--brand-color', color)
}

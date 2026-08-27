const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api'

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const browser = globalThis as typeof globalThis & { sessionStorage?: { getItem: (key: string) => string | null } }
  const token = browser.sessionStorage?.getItem('mespoches_token') ?? null
  const response = await fetch(`${API_URL}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } })
  const payload = (await response.json().catch(() => ({}))) as { data?: T; message?: string }
  if (!response.ok) throw new Error(payload.message || 'Une erreur est survenue')
  return payload.data ?? (payload as T)
}

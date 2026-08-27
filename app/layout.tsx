import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = { title: 'Mes Poches — Votre argent, en clair', description: 'Pilotez vos finances avec calme et précision.' }

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fr" className="bg-paper"><body>{children}</body></html>
}

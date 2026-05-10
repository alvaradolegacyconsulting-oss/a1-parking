'use client'
import { useState } from 'react'

type Props = {
  email: string
  password: string
  title?: string
  onClose: () => void
}

export default function CredentialsModal({ email, password, title, onClose }: Props) {
  const [copied, setCopied] = useState(false)

  async function copyCreds() {
    const text = `Email: ${email}\nPassword: ${password}`
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable — fall back to manual select. The text
      // is visible in the modal so the user can highlight it.
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '20px' }}>
      <div style={{ background: '#161b26', border: '2px solid #C9A227', borderRadius: '12px', padding: '24px', maxWidth: '420px', width: '100%' }}>
        <h2 style={{ color: '#C9A227', fontSize: '16px', fontWeight: 'bold', margin: '0 0 12px' }}>
          {title || 'Resident Added — Share Login Credentials'}
        </h2>
        <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: '8px', padding: '14px', marginBottom: '12px' }}>
          <p style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Email</p>
          <p style={{ color: 'white', fontSize: '14px', fontFamily: 'Courier New', wordBreak: 'break-all', margin: '0 0 12px' }}>{email}</p>
          <p style={{ color: '#888', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 4px' }}>Temp Password</p>
          <p style={{ color: '#C9A227', fontSize: '18px', fontFamily: 'Courier New', fontWeight: 'bold', letterSpacing: '0.04em', margin: '0', wordBreak: 'break-all' }}>{password}</p>
        </div>
        <div style={{ background: '#2a1f0a', border: '1px solid #a16207', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px' }}>
          <p style={{ color: '#fbbf24', fontSize: '12px', margin: '0', lineHeight: '1.6' }}>
            ⚠ Shown <strong>once</strong>. Share with the resident via your preferred method (text, email, in person). They will be required to change the password on first login.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={copyCreds}
            style={{ flex: 1, padding: '11px', background: copied ? '#1a3a1a' : '#1e2535', color: copied ? '#4caf50' : '#C9A227', fontWeight: 'bold', fontSize: '13px', border: '1px solid ' + (copied ? '#2e7d32' : '#C9A227'), borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
            {copied ? '✓ Copied' : 'Copy Credentials'}
          </button>
          <button onClick={onClose}
            style={{ padding: '11px 22px', background: '#C9A227', color: '#0f1117', fontWeight: 'bold', fontSize: '13px', border: 'none', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Arial' }}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

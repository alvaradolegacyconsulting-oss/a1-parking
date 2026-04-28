'use client'
import { useEffect } from 'react'

export default function Dashboard() {
  useEffect(() => {
    window.location.href = '/'
  }, [])

  return (
    <main style={{ minHeight:'100vh', background:'#0f1117', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'Arial, sans-serif' }}>
      <p style={{ color:'#888' }}>Loading...</p>
    </main>
  )
}
'use client'
// AP-MANAGE-CLIENT (2026-07-23): remove-confirm modal for
// authorized_plates. Matches the b228 DeactivateResidentModal pattern
// (state + explicit confirm, no inline single-click removal).
//
// Modal copy names the consequence explicitly ("can then be cited or
// towed like any other unregistered vehicle") — enforcement-relevant
// action, single-click removal is the wrong affordance.

interface Props {
  target: { id: number; plate: string; label: string | null; added_at: string }
  propertyName: string
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export default function AuthorizedPlateRemoveConfirmModal({ target, propertyName, onClose, onConfirm }: Props) {
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000, padding:'20px' }}
      onClick={onClose}>
      <div style={{ background:'#161b26', border:'1px solid #2a2f3d', borderRadius:'10px', padding:'20px', maxWidth:'440px', width:'100%', boxSizing:'border-box' as const }}
        onClick={e => e.stopPropagation()}>
        <p style={{ color:'#f44336', fontWeight:'bold', fontSize:'15px', margin:'0 0 10px' }}>Remove authorization?</p>
        <p style={{ color:'#ddd', fontSize:'13px', margin:'0 0 8px', lineHeight:'1.6' }}>
          <span style={{ fontFamily:'Courier New', fontWeight:'bold', letterSpacing:'0.08em', color:'white' }}>{target.plate}</span>
          {' '}will no longer show as Authorized when scanned at{' '}
          <strong style={{ color:'white' }}>{propertyName}</strong>. This vehicle can then be cited or towed like any other unregistered vehicle.
        </p>
        {target.label && (
          <p style={{ color:'#888', fontSize:'12px', fontStyle:'italic', margin:'0 0 8px', lineHeight:'1.5' }}>Label: {target.label}</p>
        )}
        <p style={{ color:'#888', fontSize:'11px', margin:'0 0 16px', lineHeight:'1.5' }}>
          Soft-delete — the record is preserved for audit; only the active flag is removed. Added {new Date(target.added_at).toLocaleDateString()}.
        </p>
        <div style={{ display:'flex', gap:'8px', justifyContent:'flex-end' }}>
          <button onClick={onClose}
            style={{ padding:'8px 16px', background:'#1e2535', color:'#aaa', border:'1px solid #3a4055', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
            Cancel
          </button>
          <button onClick={onConfirm}
            style={{ padding:'8px 16px', background:'#991b1b', color:'white', border:'none', borderRadius:'6px', cursor:'pointer', fontSize:'12px', fontWeight:'bold', fontFamily:'Arial' }}>
            Remove authorization
          </button>
        </div>
      </div>
    </div>
  )
}

import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  console.log('scan-plate API called')

  const { image } = await request.json()
  if (!image) return NextResponse.json({ error: 'No image provided' }, { status: 400 })

  const apiKey = process.env.ANTHROPIC_API_KEY
  console.log('API key exists:', !!apiKey)
  if (!apiKey) return NextResponse.json({ error: 'Plate scanning not configured' }, { status: 500 })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 20,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: image },
          },
          {
            type: 'text',
            text: 'This is a photo of a vehicle license plate. Extract ONLY the license plate number/letters. Return ONLY the plate text with no spaces, no punctuation, no explanation. Just the alphanumeric characters on the plate.',
          },
        ],
      }],
    }),
  })

  console.log('Anthropic response status:', response.status)
  const responseText = await response.text()
  console.log('Anthropic response:', responseText)

  let data: any
  try {
    data = JSON.parse(responseText)
  } catch {
    return NextResponse.json({ error: 'Invalid response from API' }, { status: 500 })
  }

  if (!response.ok) {
    return NextResponse.json({ error: data.error?.message || 'API error' }, { status: 500 })
  }

  const plate = (data.content?.[0]?.text || '')
    .trim()
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .slice(0, 8)

  return NextResponse.json({ plate })
}

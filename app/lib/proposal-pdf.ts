import puppeteer, { type Browser } from 'puppeteer-core'
import chromium from '@sparticuz/chromium'
import { renderProposalPdfHtml, ProposalForPdf } from './proposal-pdf-template'

async function launchBrowser(): Promise<Browser> {
  // On Vercel (Linux serverless), @sparticuz/chromium provides the binary.
  // On macOS/Windows local dev, fall back to a system Chrome.
  const isServerless = !!process.env.VERCEL || process.env.NODE_ENV === 'production'
  if (isServerless) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }
  // Local dev: use installed Chrome / Chromium binary.
  const localCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean) as string[]
  return puppeteer.launch({
    headless: true,
    executablePath: localCandidates[0] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
}

export async function generateProposalPdf(
  proposal: ProposalForPdf,
  opts: { logoUrl: string | null; appUrl: string }
): Promise<Buffer> {
  const html = renderProposalPdfHtml(proposal, opts)
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.4in', right: '0.4in', bottom: '0.4in', left: '0.4in' },
    })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}

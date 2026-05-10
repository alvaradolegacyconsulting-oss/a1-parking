import puppeteer, { type Browser } from 'puppeteer-core'
import chromium from '@sparticuz/chromium'
import { existsSync } from 'node:fs'
import { renderProposalPdfHtml, ProposalForPdf } from './proposal-pdf-template'

async function launchBrowser(): Promise<Browser> {
  // Use Vercel as the canonical signal for serverless. On Vercel, the only
  // working setup is @sparticuz/chromium's args + executablePath +
  // defaultViewport + headless. Setting `headless: true` (a boolean) instead
  // of `chromium.headless` skips @sparticuz's library-path setup and the
  // bundled Chromium fails to load libnss3.so.
  const isVercel = !!process.env.VERCEL
  if (isVercel) {
    return puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    })
  }
  // Local dev: env var override > standard macOS Chrome path.
  const localPath = process.env.PUPPETEER_EXECUTABLE_PATH
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  return puppeteer.launch({
    args: [],
    headless: true,
    executablePath: localPath,
  })
}

export async function generateProposalPdf(
  proposal: ProposalForPdf,
  opts: { logoUrl: string | null; appUrl: string }
): Promise<Buffer> {
  // Diagnostic logging for Vercel troubleshooting (commit c7a6115 follow-up).
  // Remove once libnss3.so / launch issues are resolved.
  if (process.env.VERCEL) {
    try {
      const ep = await chromium.executablePath()
      console.log('[proposal-pdf] VERCEL=', process.env.VERCEL)
      console.log('[proposal-pdf] executablePath=', ep)
      console.log('[proposal-pdf] file exists at executablePath=', ep ? existsSync(ep) : 'n/a (no path)')
      console.log('[proposal-pdf] chromium.headless=', String(chromium.headless))
      console.log('[proposal-pdf] chromium.args.length=', chromium.args.length)
    } catch (e) {
      console.log('[proposal-pdf] diagnostic log failed:', (e as Error).message)
    }
  }
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

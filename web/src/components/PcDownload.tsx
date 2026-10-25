import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { LogoMark } from './Logo'
import { Card } from './ui'

type Bin = { os: 'windows' | 'windows-directml' | 'linux' | 'macos'; name: string; url: string; sha256: string; bytes: number }
type Bins = { built: string; run_url?: string; tag?: string; files: Bin[]; smoke?: Record<string, string>; sums_url?: string; sig_url?: string }

const mb = (b: number) => `${(b / 1e6).toFixed(0)} MB`

/** „Pobierz węzeł na PC”: pliki z wydania GitHub (zbudowane i przetestowane w CI), sumy SHA-256 z node/binaries.json. */
export function PcDownload() {
  const en = useI18n().lang === 'en'
  const base = import.meta.env.BASE_URL
  const [bins, setBins] = useState<Bins | null | undefined>()
  const [pyz, setPyz] = useState<string | undefined>()
  useEffect(() => {
    fetch(`${base}node/binaries.json`, { cache: 'no-cache' })
      .then((r) => (r.ok ? (r.json() as Promise<Bins>) : null))
      .then(setBins, () => setBins(null))
    fetch(`${base}node/mycelium-node.pyz.sha256`, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => setPyz(t.split(/\s+/)[0] || undefined), () => setPyz(undefined))
  }, [base])
  const win = bins?.files.find((f) => f.os === 'windows')
  const other = bins?.files.filter((f) => f.os !== 'windows') ?? []
  const dml = bins?.files.find((f) => f.os === 'windows-directml')
  const label = { windows: 'Windows 10/11 (64-bit)', 'windows-directml': en ? 'Windows + GPU (DirectML: AMD/Intel/NVIDIA)' : 'Windows + karta graficzna (DirectML: AMD/Intel/NVIDIA)', linux: 'Linux x64', macos: 'macOS (Apple Silicon)' }
  return (
    <Card title={en ? 'Download the node for your PC (24/7)' : 'Pobierz węzeł na PC (24/7)'} className="mt-4">
      <div className="card-glow -mx-1 mb-4 flex items-center gap-3 rounded-2xl p-3 sm:mx-0">
        <LogoMark size={52} className="logo-live shrink-0" />
        <div className="min-w-0">
          <div className="font-semibold text-slate-50">Mycelium AI Node</div>
          <div className="text-xs text-slate-400">
            {bins?.sig_url ? (en ? 'Signed builds (Sigstore) · ' : 'Podpisane wersje (Sigstore) · ') : ''}
            {en ? 'Windows, Linux x64, macOS · runs 24/7 with low priority' : 'Windows, Linux x64, macOS · działa 24/7 z niskim priorytetem'}
          </div>
        </div>
      </div>
      <div data-testid="pc-download" className="grid gap-4 lg:grid-cols-2">
        <div>
          {bins === undefined ? (
            <p className="text-sm text-slate-500">…</p>
          ) : !win ? (
            <p className="text-sm text-slate-400" data-testid="pc-no-build">
              {en ? 'The Windows build is not published yet (built and tested by CI). Use the .pyz file below meanwhile.' : 'Wersja dla Windows nie jest jeszcze opublikowana (buduje i testuje ją CI). Do tego czasu użyj pliku .pyz poniżej.'}
            </p>
          ) : (
            <a href={win.url} className="inline-block rounded-xl bg-gradient-to-r from-spore to-sky px-5 py-3 text-base font-semibold text-ink shadow-[0_10px_30px_-12px_rgb(94_234_212/0.7)] transition hover:brightness-110" data-testid="pc-win">
              ⬇ {en ? 'Download for Windows' : 'Pobierz dla Windows'} ({mb(win.bytes)})
            </a>
          )}
          {dml && (
            <p className="mt-2 text-xs text-slate-400" data-testid="pc-dml">
              {en ? 'Graphics card (also integrated AMD Radeon / Intel)? ' : 'Masz kartę graficzną (także zintegrowaną AMD Radeon / Intel)? '}
              <a className="text-glow underline" href={dml.url}>MyceliumNode-DirectML.exe</a> ({mb(dml.bytes)}){' '}
              {en
                ? '– tests CPU vs GPU on your computer and uses the GPU only if it is faster and gives the same loss.'
                : '– sprawdza na Twoim komputerze CPU vs GPU i używa GPU tylko, gdy jest szybsze i daje tę samą stratę.'}
            </p>
          )}
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-300">
            <li>{en ? 'Run MyceliumNode.exe (no Python needed).' : 'Uruchom MyceliumNode.exe (nie trzeba instalować Pythona).'}</li>
            <li>{en ? 'Choose CPU threads, optional RAM limit and “start automatically after login”.' : 'Wybierz liczbę wątków CPU, ewentualny limit RAM i „uruchamiaj automatycznie po zalogowaniu”.'}</li>
            <li>{en ? 'The first start downloads the model once (~1 GB, resumable, SHA-256 checked).' : 'Pierwszy start pobiera raz model (ok. 1 GB, ze wznawianiem i sprawdzeniem SHA-256).'}</li>
            <li>
              {en ? 'Status (connected, tasks, tokens, contribution): ' : 'Stan (połączenie, zadania, tokeny, wkład): '}
              <span className="font-mono">http://127.0.0.1:8765</span>
            </li>
          </ol>
          <p className="mt-2 rounded-lg border border-amber/30 bg-amber/5 p-2 text-xs text-amber" data-testid="smartscreen">
            {en
              ? 'Windows SmartScreen will warn “unknown publisher”: the file is not code-signed (a certificate costs money). Click “More info” → “Run anyway” only if the SHA-256 below matches. The program runs with low priority and only for your user (no administrator rights).'
              : 'Windows SmartScreen pokaże „nieznany wydawca”: plik nie jest podpisany certyfikatem (certyfikat jest płatny). Kliknij „Więcej informacji” → „Uruchom mimo to” tylko, gdy suma SHA-256 poniżej się zgadza. Program działa z niskim priorytetem i tylko dla Twojego użytkownika (bez praw administratora).'}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            {en
              ? 'Uses ~2.5 GB RAM for chat, ~4 GB with training (~3 GB with --max-ram-gb 3); CPU by default (GPU only in the DirectML build, after a test). Stop: close the window; remove autostart: '
              : 'Zużywa ok. 2,5 GB RAM na czat, ok. 4 GB z treningiem (ok. 3 GB z limitem --max-ram-gb 3); domyślnie CPU (GPU tylko w wersji DirectML, po teście). Stop: zamknij okno; usunięcie autostartu: '}
            <span className="font-mono">MyceliumNode.exe --uninstall</span>
          </p>
        </div>
        <div className="text-xs text-slate-400">
          <div className="mb-1 font-semibold text-slate-300">{en ? 'Files and SHA-256' : 'Pliki i sumy SHA-256'}</div>
          <ul className="space-y-2" data-testid="pc-files">
            {[...(win ? [win] : []), ...other].map((f) => (
              <li key={f.name}>
                <a className="text-glow underline" href={f.url}>
                  {label[f.os]}: {f.name}
                </a>{' '}
                ({mb(f.bytes)})<div className="break-all font-mono text-[10px] text-slate-500">{f.sha256}</div>
              </li>
            ))}
            <li>
              <a className="text-glow underline" href={`${base}node/mycelium-node.pyz`}>
                {en ? 'Any OS with Python 3.10+' : 'Dowolny system z Pythonem 3.10+'}: mycelium-node.pyz
              </a>
              <div className="break-all font-mono text-[10px] text-slate-500">{pyz ?? '—'}</div>
            </li>
          </ul>
          {bins?.built && (
            <p className="mt-2">
              {en ? 'Built and smoke-tested by GitHub Actions' : 'Zbudowane i przetestowane (start + połączenie) w GitHub Actions'}: {new Date(bins.built).toLocaleString(en ? 'en-GB' : 'pl-PL', { timeZone: 'Europe/Amsterdam' })}
              {bins.run_url && (
                <>
                  {' · '}
                  <a className="underline" href={bins.run_url}>
                    {en ? 'build log' : 'dziennik budowania'}
                  </a>
                </>
              )}
            </p>
          )}
          <p className="mt-2">
            {en ? 'Check on Windows (PowerShell): ' : 'Sprawdzenie na Windows (PowerShell): '}
            <span className="font-mono">Get-FileHash .\MyceliumNode.exe</span>
            {en ? ' · Linux/macOS: ' : ' · Linux/macOS: '}
            <span className="font-mono">shasum -a 256 &lt;plik&gt;</span>
          </p>
          <div className="mt-2" data-testid="pc-verify">
            <div className="font-semibold text-slate-300">{en ? 'Verify the signature (optional)' : 'Sprawdź podpis (opcjonalnie)'}</div>
            {bins?.sig_url ? (
              <>
                <p>
                  {en
                    ? 'Each release is signed by this GitHub workflow (Sigstore, no keys to leak) and has a GitHub build attestation:'
                    : 'Każde wydanie jest podpisane przez ten workflow GitHub (Sigstore, bez kluczy, które mogłyby wyciec) i ma poświadczenie pochodzenia GitHub:'}
                </p>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-black/30 p-2 font-mono text-[10px] text-slate-300">
                  {`gh attestation verify MyceliumNode.exe -R maciejsearch-cloud/demo

cosign verify-blob --bundle SHA256SUMS.txt.sigstore.json \
  --certificate-identity-regexp '^https://github.com/maciejsearch-cloud/demo/.github/workflows/mycelium-node-build.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS.txt
sha256sum -c --ignore-missing SHA256SUMS.txt`}
                </pre>
                <p className="mt-1">
                  <a className="underline" href={bins.sums_url}>
                    SHA256SUMS.txt
                  </a>{' '}
                  ·{' '}
                  <a className="underline" href={bins.sig_url}>
                    SHA256SUMS.txt.sigstore.json
                  </a>
                </p>
              </>
            ) : (
              <p>{en ? 'Signed releases start with the next build; until then compare SHA-256.' : 'Podpisane wydania od następnej wersji; do tego czasu porównaj SHA-256.'}</p>
            )}
            <p className="mt-1">
              {en
                ? 'The node has no self-update: a new version is always a new download you can verify. No Windows/Apple publisher certificate yet, so SmartScreen/Gatekeeper will warn.'
                : 'Węzeł nie aktualizuje się sam: nowa wersja to zawsze nowe pobranie, które możesz sprawdzić. Nie ma jeszcze certyfikatu wydawcy Windows/Apple, więc SmartScreen/Gatekeeper ostrzeże.'}
            </p>
          </div>
          <p className="mt-2">
            {en
              ? 'Linux/macOS: chmod +x the file and run it in a terminal; autostart = systemd user service / launchd. Same questions as on Windows.'
              : 'Linux/macOS: nadaj plikowi prawo wykonania (chmod +x) i uruchom w terminalu; autostart = usługa systemd użytkownika / launchd. Te same pytania co na Windows.'}
          </p>
        </div>
      </div>
    </Card>
  )
}

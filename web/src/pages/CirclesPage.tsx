import { useEffect, useSyncExternalStore } from 'react'
import { Circles } from '../components/Circles'
import { PageHeader } from '../components/ui'
import { useI18n } from '../i18n'
import { account } from '../myc/account'

/** Rozmowa → Kręgi: te same kręgi co w Koncie, pod ręką obok czatu. Bez konta – link do założenia. */
export default function CirclesPage() {
  const en = useI18n().lang === 'en'
  useSyncExternalStore(account.subscribe, account.getVersion)
  useEffect(() => {
    if (account.me === undefined) void account.refresh()
  }, [])
  return (
    <div>
      <PageHeader title={en ? 'Circles' : 'Kręgi'}>
        {en
            ? 'Groups of friends with an invite code, trust from verified contribution and a circle channel in the chat.'
            : 'Grupy znajomych z kodem zaproszenia, zaufaniem z prawdziwego wkładu i kanałem kręgu w czacie.'}
      </PageHeader>
      {account.me === undefined && <div className="card skeleton h-32" />}
      {account.me === null && (
        <div className="card text-sm text-slate-300" data-testid="circles-need-account">
          {en ? 'Circles need an anonymous account. ' : 'Kręgi wymagają anonimowego konta. '}
          <a className="text-spore underline" href="#/konto">
            {en ? 'Create one in Account →' : 'Załóż je w Koncie →'}
          </a>
        </div>
      )}
      {account.me && <Circles />}
    </div>
  )
}

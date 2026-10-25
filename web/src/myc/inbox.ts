/** Wspólne filtry skrzynki Weryfikuj (stan + pewność AI) dla wszystkich rodzajów pozycji. */
export type IState = 'czeka' | 'sporne' | 'zatwierdzone'
export type IConf = 'all' | 'low' | 'mid' | 'high'
export interface InboxProps {
  state?: IState
  conf?: IConf
  onCount?: (n: number) => void
}
export const inConf = (c: number | null | undefined, f: IConf = 'all') => f === 'all' || (c != null && (f === 'low' ? c < 0.5 : f === 'mid' ? c >= 0.5 && c < 0.8 : c >= 0.8))
/** sporne głosowanie ludzi: są głosy, a wynik wciąż między 20% a 80% */
export const split = (nVotes: number, posterior: number) => nVotes > 0 && posterior > 0.2 && posterior < 0.8

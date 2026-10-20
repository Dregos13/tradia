import tradiaMark from '../assets/brand/tradia-mark.svg';

/** El nombre pertenece al conjunto; el símbolo no se anuncia por separado. */
export function TradiaBrand() {
  return (
    <div className="logo" role="img" aria-label="Tradia">
      <img
        className="brand-mark"
        src={tradiaMark}
        width="24"
        height="24"
        alt=""
        aria-hidden="true"
      />
      <span className="brand-wordmark">Tradia</span>
    </div>
  );
}

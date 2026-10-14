import tradiaMark from '../assets/brand/tradia-mark.svg';

/** El nombre pertenece al conjunto; el símbolo no se anuncia por separado. */
export function TradiaBrand() {
  return (
    <div className="logo" role="img" aria-label="Tradia">
      <img className="brand-mark" src={tradiaMark} alt="" aria-hidden="true" />
      <span>Tradia</span>
    </div>
  );
}

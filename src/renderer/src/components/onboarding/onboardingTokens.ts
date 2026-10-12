import tokens from '../../design/onboarding.tokens.json';

export function onboardingTokenStylesheet(): string {
  const declarations = (values: Record<string, string | number>) =>
    Object.entries(values)
      .map(([key, value]) => `--onboarding-${key}:${value};`)
      .join('');
  const theme = (mode: 'light' | 'dark') => {
    const tour = tokens.color.tour;
    return declarations({
      scrim: tour.scrim[mode],
      ring: tour.spotlightRing[mode],
      halo: tour.spotlightHalo[mode],
      'popover-color': tour.popover[mode],
      border: tour.popover.border[mode],
      title: tour.popover.title[mode],
      body: tour.popover.body[mode],
      done: tour.progressDone[mode],
      pending: tour.progressPending[mode],
      label: tour.stepLabel[mode],
      'label-surface': tour.stepLabel[`${mode === 'light' ? 'surfaceLight' : 'surfaceDark'}`],
      ...Object.fromEntries(
        Object.entries(tokens.color.firstSteps).flatMap(([key, value]) => [
          [`first-${key}`, value[mode]],
          [`first-${key}-surface`, value[`${mode}Surface`]],
        ]),
      ),
    });
  };
  const common = declarations({
    ...tokens.size,
    ...tokens.radius,
    spotlightMove: tokens.motion.spotlightMove,
    popoverEnter: tokens.motion.popoverEnter,
    easeOut: tokens.motion.easeOut,
    ringWidth: tokens.color.tour.spotlightRing.width,
    haloWidth: tokens.color.tour.spotlightHalo.width,
    shadow: tokens.shadow.popover.value,
    scrimZ: tokens.zIndex.scrim,
    spotlightZ: tokens.zIndex.spotlight,
    popoverZ: tokens.zIndex.popover,
  });
  return `:root{${common}${theme('light')}}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${theme('dark')}}}:root[data-theme="dark"]{${theme('dark')}}`;
}

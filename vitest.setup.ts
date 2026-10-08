import { expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';

// Registra los matchers de jest-dom sobre el `expect` del runner. Se hace
// aquí y no solo con `import '@testing-library/jest-dom/vitest'` en cada
// prueba porque, cuando node_modules está enlazado fuera del root del
// proyecto, vitest externaliza ese módulo y su `expect.extend` cae sobre
// otra instancia de `expect`. Este archivo va inline: extiende el correcto.
expect.extend(matchers);

/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAB_API_BASE_URL?: string;
  /** «1» shows Точность and the simulations, hidden in the first release (app/product). */
  readonly VITE_ALL_CHECKS?: string;
}

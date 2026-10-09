/**
 * What the product shows its users. The first release checks tone of voice only: Точность and the simulations are
 * hidden, not removed — their pages, their data and the server stay as they are, and a build with VITE_ALL_CHECKS=1
 * shows them again. «Обзор», «Датасеты» and every page of tone of voice are shown either way. The agent is reached on
 * the test stand only (LOCAL_AGENT): tone of voice checks the recorded answers or asks the agent on the stand.
 */
export const ALL_CHECKS = import.meta.env.VITE_ALL_CHECKS === "1";

/** Точность: its section, its card on «Обзор» and «Датасеты», the agent's code and knowledge base on «Агент». */
export const ACCURACY = ALL_CHECKS;

/** The simulations: their section, the launch's third way, the scenarios a problem is played in. */
export const SIMULATIONS = ALL_CHECKS;

/**
 * The agent on this computer and the agent started from its code. The first release asks the agent on the bank's test
 * stand only; these two ways stay in the service, and a build with VITE_ALL_CHECKS=1 offers them again.
 */
export const LOCAL_AGENT = ALL_CHECKS;

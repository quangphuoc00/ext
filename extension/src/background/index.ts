// FROZEN (Phase 0). Service-worker entrypoint. Wires the two subsystems:
//   - startEngine()         : scraping orchestrator + polling (Agent A)
//   - startAnalysisWorker() : Realtime consumer driving claude.ai (Agent D)
import { startEngine } from "./scrapeOrchestrator";
import { startAnalysisWorker } from "./analysisWorker";

startEngine();
startAnalysisWorker();

import { runMediumTierKillSwitchContract } from './shared/kill-switch-spec.js';
import { buildProcessSupervisorFixture } from '../../examples/kill-switches/process-supervisor/test/test-fixture.js';

// ProcessSupervisor is the canonical reference impl of MediumTierKillSwitch.
// Mirrors the pattern in atoms.test.ts (memory adapter wired through
// runAtomsSpec) and other adapter conformance tests.
runMediumTierKillSwitchContract('ProcessSupervisor', buildProcessSupervisorFixture);

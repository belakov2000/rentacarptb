import { check, finish, setContext } from "./harness.ts";
import { noteCardActivity, shouldPollCards } from "../../server/card-poll.js";

setContext("deploy-preview");
const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
const idleTicks = [];
for (let m = 0; m < 60; m += 5) if (await shouldPollCards(at(m))) idleTicks.push(m);
check("Idle SQL checks coincide with mail jobs", idleTicks.join(",") === "0,15,30,45");
await noteCardActivity(at(3));
check("New attempt enables fast reconciliation", await shouldPollCards(at(5)) && await shouldPollCards(at(20)));
await noteCardActivity(at(20));
check("Pending work keeps fast reconciliation active", await shouldPollCards(at(35)));
check("Idle polling resumes after the hint expires", (await shouldPollCards(at(50))) === false);
await finish();

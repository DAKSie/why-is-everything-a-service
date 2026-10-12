import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate, openDb } from "../server/src/db.js";
import {
  countQuestions,
  seedQuestionsFromDataDir,
} from "../server/src/questions/load.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(rootDir, "data");
const db = openDb(path.join(dataDir, "app.db"));
migrate(db);
const seed = seedQuestionsFromDataDir(db, dataDir);
console.log(
  `Seeded upserted=${seed.upserted} from ${seed.path} (DB total=${countQuestions(db)}, attemptsPreserved=${seed.attemptsPreserved})`,
);
db.close();

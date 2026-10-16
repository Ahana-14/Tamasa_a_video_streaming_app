// import "dotenv/config";
import { app } from './app';
import { env } from './config/env';
import { UsernameFilter } from './services/username-filter.service';
import { startPurgeJob } from './services/purge.service';
import { startWorkerAutoscaler } from './services/worker-autoscale.service';
const PORT = env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  startWorkerAutoscaler();
  startPurgeJob();
  UsernameFilter.start();
});

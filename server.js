require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/api/auth');
const notificationRoutes = require('./routes/api/notifications');
const teamRoutes = require('./routes/api/teams');
const teamInvitationRoutes = require('./routes/api/teamInvitations');
const lineRoutes = require('./routes/api/lines');
const accountRoutes = require('./routes/api/accounts');
const areaRoutes = require('./routes/api/areas');
const appMainDetailsRoutes = require('./routes/api/appMainDetails');
const productRoutes = require('./routes/api/products');
const focOverrideRoutes = require('./routes/api/focOverrides');
const salesChannelRoutes = require('./routes/api/salesChannels');
const salesTeamRoutes = require('./routes/api/salesTeam');
const orderRoutes = require('./routes/api/orders');
const salesRoutes = require('./routes/api/sales');
const sharedSalesRuleRoutes = require('./routes/api/sharedSalesRules');
const medicalRepProductAssignmentRoutes = require('./routes/api/medicalRepProductAssignments');
const targetAssignmentRoutes = require('./routes/api/targetAssignments');
const targetPhasingRoutes = require('./routes/api/targetPhasing');
const forecastRoutes = require('./routes/api/forecasts');
const achievementRoutes = require('./routes/api/achievements');
const stockAccountRoutes = require('./routes/api/stockAccounts');
const accountAssignmentRoutes = require('./routes/api/accountAssignments');
const cleanupObsoleteIndexes = require('./helpers/cleanupObsoleteIndexes');
const ensureSalesChannelGroups = require('./helpers/ensureSalesChannelGroups');
const { startDailySalesMatchingScheduler } = require('./services/salesMatchingScheduler');

const app = express();
const PORT = process.env.PORT || 5000;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 300000;

const corsOptions = {
  origin: '*',
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Origin'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges'],
  optionsSuccessStatus: 200,
};

app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.options('*', cors(corsOptions));
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'AeroPlan API running',
    fields: {
      environment: process.env.NODE_ENV || 'development',
      mongoConfigured: Boolean(process.env.MONGO_URI || process.env.mongoURI),
      timestamp: new Date().toISOString()
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'AeroPlan API running'
  });
});

app.use('/api/auth', authRoutes);
app.use('/auth', authRoutes);
app.use('/', authRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/team-invitations', teamInvitationRoutes);
app.use('/api/lines', lineRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/areas', areaRoutes);
app.use('/api/app-main-details', appMainDetailsRoutes);
app.use('/api/sales-channels', salesChannelRoutes);
app.use('/api/sales-team', salesTeamRoutes);
app.use('/api/products', productRoutes);
app.use('/api/foc-overrides', focOverrideRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/shared-sales-rules', sharedSalesRuleRoutes);
app.use('/api/medical-rep-product-assignments', medicalRepProductAssignmentRoutes);
app.use('/api/target-assignments', targetAssignmentRoutes);
app.use('/api/target-phasing', targetPhasingRoutes);
app.use('/api/forecasts', forecastRoutes);
app.use('/api/achievements', achievementRoutes);
app.use('/api/account-assignments', accountAssignmentRoutes);
app.use('/api/stock-accounts', stockAccountRoutes);
app.use('/products', productRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

app.use(errorHandler);

const startServer = async () => {
  await connectDB();
  await cleanupObsoleteIndexes();
  await ensureSalesChannelGroups();
  startDailySalesMatchingScheduler();

  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = REQUEST_TIMEOUT_MS + 5000;
  server.keepAliveTimeout = 65000;
};

startServer();

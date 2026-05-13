require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const connectDB = require('./config/db');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/api/auth');
const cleanupObsoleteIndexes = require('./helpers/cleanupObsoleteIndexes');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(helmet());
app.use(cors());
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

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
};

startServer();

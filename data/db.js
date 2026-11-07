require('dotenv').config();

const mysql = require('mysql2/promise');
const fs = require('fs');

function getSslConfig() {
  if (String(process.env.DB_SSL || 'true').toLowerCase() === 'false') {
    return undefined;
  }

  const config = { rejectUnauthorized: true };
  if (process.env.DB_SSL_CA) {
    config.ca = fs.readFileSync(process.env.DB_SSL_CA, 'utf8');
  }

  return config;
}

async function connectDB() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.srv1847.hstgr.io,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.u191777912_systechng,
      password: process.env.Alamanjo@090,
      database: process.env.u191777912_systech,
      ssl: getSslConfig()
    });

    console.log('Connected to Hostinger MySQL!');

    const [rows] = await connection.query(
      'SELECT NOW() AS server_time'
    );

    console.log(rows);

    await connection.end();
  } catch (error) {
    console.error('Database connection failed:', error.message);
  }
}

connectDB();
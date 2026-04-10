#!/bin/bash
# Keep-alive script for LMS
# Run this every 5-10 minutes using cron or a scheduler

APP_URL="https://fluent-feathers-academy-lms.onrender.com"

echo "$(date): Pinging $APP_URL/api/ping"
curl -s "$APP_URL/api/ping" > /dev/null
echo "Ping sent"
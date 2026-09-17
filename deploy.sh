cat > deploy.sh <<'EOF'
#!/bin/bash
echo "===== 开始拉取代码 ====="
git pull

echo "===== 安装依赖 ====="
npm install

echo "===== PM2重启服务 ====="
pm2 restart 0

echo "===== 查看最近日志 ====="
pm2 logs 0 --lines 10
EOF
chmod +x deploy.sh

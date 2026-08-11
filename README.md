# 🛰️ IoT Monitor — Sistema de Monitoramento ESP32

Dashboard estilo Grafana para monitoramento de sensores via MQTT + MariaDB.

---

## 📁 Estrutura

```
iotmonitor/
├── backend/
│   ├── server.js         ← Servidor Node.js principal
│   ├── certs/
│   │   └── isrg_root_x1.pem  ← Certificado TLS MQTT
│   └── package.json
└── frontend/
    └── public/
        ├── index.html    ← Interface do dashboard
        ├── style.css     ← Tema dark estilo Grafana
        └── app.js        ← Lógica da aplicação
```

---

## 🔧 Instalação

### Pré-requisitos
- Node.js 18+
- MariaDB rodando em 127.0.0.1:3306
- Broker MQTT acessível em mqtt.iotgili.com:8883

### Passos

```bash
# 1. Entrar na pasta do backend
cd iotmonitor/backend

# 2. Instalar dependências
npm install

# 3. Iniciar o servidor
node server.js
```

Acesse: **http://localhost:3000**

---

## 🔐 Credenciais Padrão

| Campo    | Valor       |
|----------|-------------|
| Usuário  | `admin`     |
| Senha    | `admin`|

> ⚠️ **ALTERE A SENHA NO PRIMEIRO LOGIN!**  
> Clique em "⚙ Senha" na barra superior.

---

## 🛡️ Segurança Implementada

### Autenticação
- JWT com expiração de 8 horas
- Bloqueio automático após 5 tentativas falhas (15 min)
- Rate limiting: 200 req/15min global, 10 req/15min no login
- Senhas com bcrypt (custo 12)

### Rede
- MQTT via TLS (porta 8883) com certificado ISRG Root X1
- Helmet.js: headers de segurança HTTP
- CORS restrito à origem do servidor
- Content-Security-Policy configurado

### Banco de Dados
- Credenciais nunca expostas ao frontend
- Queries parametrizadas (sem SQL injection)
- Pool de conexões com limite controlado

### Auditoria
- Log de todas as ações: login, criação/remoção de usuários e dispositivos
- Tabela `audit_log` com IP, usuário e timestamp

### WebSocket
- Autenticação via token JWT na URL de conexão
- Conexão recusada sem token válido

---

## 📡 Configuração do ESP32

### Tópicos MQTT (exemplos)
```
esp32/sala/temperature
esp32/sala/humidity
esp32/externo/temperature
```

### Formatos aceitos
```json
{ "value": 23.5, "unit": "°C", "type": "temperature" }
```
Ou simplesmente:
```
23.5
```

### Código Arduino (exemplo básico)
```cpp
#include <WiFi.h>
#include <PubSubClient.h>

const char* mqtt_server = "mqtt.iotgili.com";
const int   mqtt_port   = 8883;
const char* mqtt_user   = "SEU_USUARIO_MQTT";
const char* mqtt_pass   = "SUA_SENHA_MQTT";

// Publicar temperatura
void publishSensor() {
  String payload = "{\"value\":" + String(temperatura) + ",\"unit\":\"°C\",\"type\":\"temperature\"}";
  client.publish("esp32/sala/temperature", payload.c_str());
}
```

---

## 🖥️ Funcionalidades

| Feature | Descrição |
|---------|-----------|
| **Dashboard** | Painéis de gráficos configuráveis, atualização em tempo real |
| **Sensores** | Cards ao vivo de todos os tópicos MQTT |
| **Dispositivos** | Cadastro de ESP32s com prefixo de tópico |
| **Alertas** | Regras de disparo por threshold, notificação em tempo real |
| **Usuários** | Gerenciamento multi-usuário com roles (admin/viewer) |
| **Auditoria** | Log completo de ações do sistema |
| **Mobile** | Interface responsiva para celular |

---

## 🔄 Variáveis de Ambiente (opcional)

```bash
PORT=4000
JWT_SECRET=sua-chave-ultra-secreta
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=meu_banco
DB_USER=root
DB_PASS=sua_senha
```

---

## ⚙️ Produção (PM2)

```bash
npm install -g pm2
cd iotmonitor/backend
pm2 start server.js --name iotmonitor
pm2 save
pm2 startup
```

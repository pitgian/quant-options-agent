# Setup cron-job.org per aggiornare i dati ogni 5 minuti

GitHub Actions throttla i cron schedule — il nostro `*/5` viene eseguito solo ogni 2-4 ore. Per avere dati freschi ogni 5 minuti, usiamo cron-job.org per triggerare il workflow via API.

## Step 1: Creare un GitHub Personal Access Token

1. Vai su **GitHub** → clicca la tua foto profilo (in alto a destra) → **Settings**
2. Scorri in basso nella sidebar sinistra → **Developer settings**
3. Clicca **Personal access tokens** → **Tokens (classic)**
4. Clicca **Generate new token (classic)**
5. Compila:
   - **Note**: `cron-job.org trigger`
   - **Expiration**: scegli 90 days o Custom (più lungo è, meglio è)
   - **Select scopes**: seleziona solo **`repo`** (full control of private repositories)
     - Se il repo è **pubblico**, basta selezionare **`public_repo`**
6. Clicca **Generate token**
7. ⚠️ **Copia il token subito** — non potrai più vederlo dopo!

## Step 2: Configurare cron-job.org

1. Vai su **https://cron-job.org** e registrati gratuitamente (o accedi)
2. Clicca **"Create Cronjob"**
3. Compila i campi:

### Generale
| Campo | Valore |
|-------|--------|
| **Title** | `Options Data Fetch` |
| **URL** | `https://api.github.com/repos/pitgian/quant-options-agent/actions/workflows/fetch-options-data.yml/dispatches` |
| **Execution** | Abilitato (toggle ON) |

### Schedule
| Campo | Valore |
|-------|--------|
| **Minute** | `*/5` (ogni 5 minuti) |
| **Hour** | `13-20` (orario UTC = 9:30AM-4PM ET, orario di mercato US) |
| **Day of Month** | `*` |
| **Month** | `*` |
| **Day of Week** | `1-5` (Lunedì-Venerdì) |

### Request
| Campo | Valore |
|-------|--------|
| **Request method** | `POST` |
| **Headers** | Vedi sotto |
| **Body** | `{"ref":"master"}` |

### Headers (uno per riga)
```
Authorization: Bearer IL_TUO_TOKEN_QUI
Accept: application/vnd.github+json
Content-Type: application/json
```

**⚠️ Sostituisci `IL_TUO_TOKEN_QUI` con il token generato allo Step 1!**

4. Clicca **Create cronjob**

## Step 3: Verificare

1. Aspetta 5 minuti
2. Vai su **https://github.com/pitgian/quant-options-agent/actions**
3. Dovresti vedere nuove esecuzioni del workflow "Fetch Options Data" triggerate da "Manually run by pitgian" (le chiamate API `workflow_dispatch` appaiono come manuali)
4. Verifica che i dati si aggiornino nel sito

## Risoluzione problemi

### Il cron job non triggera
- Verifica che il token sia corretto e non scaduto
- Verifica che l'URL sia esatto (controlla il nome del workflow file)
- Controlla i log su cron-job.org per errori HTTP (deve ritornare 204 No Content)

### Errore 401 Unauthorized
- Il token è scaduto o non ha i permessi corretti
- Rigenera il token con il permesso `repo`

### Errore 422 Unprocessable Entity
- Il body JSON non è corretto — assicurati che sia esattamente `{"ref":"master"}`

### Il workflow non produce commit
- È normale — se i dati non sono cambiati, il workflow salta il commit
- Controlla i log del workflow run su GitHub

## Note

- Il token ha una scadenza. Quando scade, rigeneralo e aggiorna la configurazione su cron-job.org
- cron-job.org è gratuito per uso personale
- Il workflow ha un `concurrency` group che accoda le esecuzioni (non le cancella)

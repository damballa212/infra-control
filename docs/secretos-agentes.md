# Secretos para agentes: diseño

Seguimiento: issue #204. Sustituye al piloto fixture-only de #200 (`pilots/credential-link`), retirado el 2026-11-11.

## Objetivo

Un agente (Claude Code, Codex, Hermes; en Mac, PC Windows o EC2) pide una credencial en cualquier contexto. A Admin le llega un aviso con enlace a Infra Control. Pega la clave o elige una existente. El agente la recibe y escribe su `.env` sin que el valor pase por el modelo ni por el chat.

## Reparto de responsabilidades

| Pieza | Hace | No hace |
|---|---|---|
| Infra Control (broker) | Recibe peticiones, avisa por push, autentica a Admin, decide alcance, entrega, audita | No muestra ni registra valores |
| Vaultwarden | Guarda los valores cifrados (organización «Agentes», colecciones por proyecto/entorno) | No lo usan los agentes directamente |
| Cliente `infra-secrets` | Pide, espera, recibe, escribe el `.env` (0600, `.gitignore`) | No imprime valores |
| Proveedor (AWS, OpenAI…) | Es la autoridad para revocar | — |

Vaultwarden no implementa Secrets Manager ni cuentas de máquina (propuesta cerrada en 2023, dani-garcia/vaultwarden#3793). La CLI `bw` es de personas: se usa solo desde el broker, con una cuenta de servicio de solo lectura.

## Contrato (a implementar en F2/F3)

1. **Pedir.** El agente se autentica con el token de su equipo y envía nombre lógico, proyecto/entorno, destino (`dotenv` con ruta relativa al proyecto, o `process`) y motivo. Con `Idempotency-Key`. Responde `{id, enlace, estado, vence}`.
2. **Avisar.** Push a Admin: quién pide, desde qué equipo, qué, para qué proyecto.
3. **Decidir.** En una sesión humana autenticada (no basta el enlace): pegar valor nuevo, elegir ítem existente o denegar. Alcance: una vez / este equipo+proyecto / siempre para el proyecto.
4. **Entregar.** El agente consulta el estado; al aprobarse, reclama la entrega una sola vez. El broker lee de la bóveda y envía el valor por TLS al cliente, que lo escribe con `envfile.write_env`.
5. **Auditar.** Se registran petición, decisión, entrega y uso con nombre, equipo, hora y alcance. Nunca valores.

Reglas fijas: TTL corto, un solo uso por entrega, replay rechazado, destino y ruta validados (sin symlinks ni rutas fuera del proyecto), cuotas por agente, fallo cerrado.

## Modelo de amenazas (resumen)

- **Agente con shell en el mismo equipo** puede leer su propio `.env` o el entorno del proceso hijo. Mitigación: claves de desarrollo con límites, bloqueo de lectura de `.env` en la configuración de los agentes, aprobación en cada uso para claves que mueven dinero. No es aislamiento absoluto.
- **Agente manipulado** (prompt injection) pidiendo una clave que no corresponde: Admin ve quién, desde dónde y para qué antes de aprobar; los alcances amplios son decisión explícita.
- **Compromiso del broker** expone lo que la cuenta de servicio puede leer. Por eso solo lectura y solo colecciones de agentes. La contraseña de esa cuenta nunca vive en el panel ni en el repo.
- **Sesión humana robada:** pegar y aprobar exigen sesión de Admin con CSRF y Origin exactos; objetivo posterior: passkey/MFA.
- **Robo del volumen de Vaultwarden:** el contenido está cifrado con la clave maestra; los backups también van cifrados.

## Dónde corre Vaultwarden (decisión pendiente)

El VPS no está en la tailnet. Opciones:

- **VPS con HTTPS público** (como el panel): sin signups, sin `/admin`, 2FA, contraseña maestra fuerte. Es el despliegue habitual de Vaultwarden. Superficie pública pequeña.
- **VPS + Tailscale instalado:** acceso solo privado. Cambia la red del VPS: requiere decisión.
- **EC2** (ya en la tailnet): privado, pero comparte host con agentes con shell; menos aislamiento y es la máquina de trabajo.

Recomendación: VPS con HTTPS público y las restricciones indicadas, a menos que prefieras instalar Tailscale allí.

## Logins web (F4)

Contraseña+2FA es el último recurso. Preferir OAuth del proveedor (p. ej. API oficial de Mercado Libre, tokens revocables) o un perfil de navegador persistente de Hermes donde Admin inicia sesión una vez. Cuentas de pago o banco: aprobación en cada uso, nunca permanente.

## Estado

| Fase | Estado |
|---|---|
| F1 Vaultwarden | **En producción**: HTTPS, registros cerrados, organización «Agentes», cuenta de servicio, backup cifrado diario con restauración verificada |
| F2 Broker real | **En producción con Vaultwarden** (`panel-0.9.2`, conector `bw`) y aviso push por solicitud nueva (categoría «Claves que piden los agentes») |
| F3 Cliente | **Instalado en EC2, MacBook Air y PC Windows** (`infra-secrets`), con reglas para Claude Code, Codex, OpenCode y Hermes en los tres. Falta la herramienta MCP |
| F3b Entrega automática | **En producción** desde `panel-0.15.0-103c818` y, con `bw serve`, en `panel-0.16.4-1b38a5d` (2026-11-24): `autoDeliver` en `hermes`, `claude-ec2`, `mac` y `pc-windows`. Cliente nuevo en EC2 y MacBook Air; PC Windows pendiente (estaba fuera de línea) |
| F4 Logins web | Sin empezar |
| F5 Vencimientos | Sin empezar |

## Equipos instalados (2026-11-11)

| Equipo | Token (panel) | Comando | Agentes con la regla |
|---|---|---|---|
| EC2 | `claude-ec2` | `~/.local/bin/infra-secrets` | Claude Code, Codex, OpenCode (repo `claude-code-config`), Hermes perfiles `dev-hub` y `personal` |
| MacBook Air | `mac` | `~/.local/bin/infra-secrets` | Claude Code, Codex, OpenCode, Hermes (`~/.hermes/skills/devops/infra-secrets`) |
| PC Windows | `pc-windows` | `infra-secrets` (carpeta `Scripts` de Python) | Claude Code, Codex, OpenCode, Hermes (`%LOCALAPPDATA%\hermes\skills\infra-secrets`) |

- Los tokens de equipo son de solo lectura con `readPolicy` sin inventario ni costes y `secretsPolicy: { projects: ["*"] }`: pueden pedir claves, no operar equipos. Cada token se generó en su equipo con `infra-secrets setup`; en el panel solo está su hash.
- Todos los agentes de un mismo equipo comparten su token (mismo usuario del sistema). `--client` solo etiqueta quién pide; no es una frontera de seguridad. Por eso un permiso «Este equipo» o «Siempre» vale para cualquier agente de ese equipo.
- `hermes` conserva su token propio con `operate` y además `secretsPolicy`.
- Reinstalar o actualizar: `tools/infra-secrets/install.sh "<Equipo>"` o `install.ps1 -Machine "<Equipo>"`; conserva el token existente.

## Configurar un agente

En el archivo privado de configuración, añadir al token del agente:

```json
{ "name": "claude-mac", "hash": "<sha256 del token>", "scopes": ["read", "operate"],
  "secretsPolicy": { "projects": ["prod-erp"], "names": ["OPENAI_API_KEY", "DATABASE_URL"] } }
```

Sin `secretsPolicy` el agente no puede pedir nada. En el equipo del agente: `INFRA_CONTROL_URL` y `INFRA_SECRETS_TOKEN` (o los archivos 0600 en `~/.config/infra-secrets/`) y
`python3 tools/infra-secrets/infra_secrets.py request OPENAI_API_KEY --project prod-erp --env dev --dest .env.local --reason "..."`.

## Búsqueda automática en la bóveda (`autoDeliver`, #258)

Con `"autoDeliver": true` en la `secretsPolicy` de un token, el panel busca la variable pedida en la colección `proyecto/entorno` de la organización «Agentes» antes de avisar a Admin (`default` si no se indica entorno):

- **Un único ítem con ese nombre exacto** (nota segura o login): la solicitud se aprueba sola para **una** entrega (`scope: once`, `auto: true`, evento de auditoría `auto_found`). No se crea un permiso permanente ni se envía push. `infra-secrets request ... --wait 0` escribe el `.env` en el acto.
- **Ninguno, varios con el mismo nombre o bóveda sin respuesta:** la solicitud queda pendiente y Admin recibe el aviso de siempre. Cuando la aprueba pegando el valor, este queda en la colección y la siguiente petición ya se resuelve sola.
- La política sigue mandando: proyecto y `names` se comprueban antes de buscar.
- `infra-secrets list --project P [--env E]` (`GET /api/secrets/available`) muestra solo los **nombres** de esa colección que el token puede pedir. Nunca muestra valores ni referencias internas.

Alcance: el panel solo lee la organización «Agentes» con su cuenta de servicio. **La bóveda personal de Admin no se consulta.** Para que un agente encuentre una clave sin preguntar, esta debe existir en Vaultwarden → organización «Agentes» → colección `proyecto/entorno`, con el nombre exacto de la variable. Sirve cualquier clave pegada antes desde el panel, o una que Admin mueva allí desde la app de Bitwarden.

Riesgo aceptado: un agente manipulado con un token `autoDeliver` puede obtener sin aviso cualquier clave de los proyectos de su política. Para claves que mueven dinero, limita `projects`/`names` o no actives `autoDeliver` en ese token. La auditoría registra cada entrega.

Logins web para el navegador de Hermes: es un canal distinto. En EC2, Hermes usa la CLI `bw` con la cuenta personal de Admin («Passwords & Logins»: rellena sin que el modelo vea la contraseña y pide la contraseña maestra en un campo oculto). No pasa por este panel.

## Instrucciones de los agentes (2026-11-11)

Hermes (EC2 `dev-hub` y `personal`, Mac y PC) tiene en su `SOUL.md` la sección «Credenciales y órdenes de Admin». Con ella usa `infra-secrets` de inmediato y crea la solicitud en vez de negarse cuando Admin da una orden o escribe una clave en el chat. Usa el valor exacto que elija Admin y no confunde el piloto retirado con el sistema real. La decisión está en ai_memory (`decisions/secretos-agentes-infra-secrets.md`, proyecto infra-control-private).


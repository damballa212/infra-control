# Monitor externo de `/health/ready`

Hoy nadie vigila al panel desde fuera de sí mismo. `GET https://panel.example.com/health/ready` es público, sin credenciales, y responde `{"status":"ready","storage":"available"}` (200) cuando el proceso y SQLite funcionan.

## Opción recomendada (gratis, sin credenciales en este repo)
UptimeRobot, plan Free (50 monitores, intervalo de 5 min, aviso por correo y push de su app):
1. Admin crea la cuenta con su correo (no hace falta tarjeta).
2. «Add New Monitor» → tipo **HTTP(s) - Keyword**; URL `https://panel.example.com/health/ready`; palabra clave `ready`; intervalo 5 min.
3. Contacto de alerta: correo de Admin (+ app móvil si quiere push). Activar «Notify when back up».
4. Opcional: segundo monitor con la URL `/health` (proceso vivo).

Por qué fuera de GitHub Actions: un `cron` de Actions queda fuera del alcance de #242 (sin workflows programados) y gastaría minutos.

## Alternativa
Healthchecks.io (free) invertido: un cron en la EC2 hace `curl` a `/health/ready` y hace ping a Healthchecks solo si responde ready; si el ping no llega, avisa. Cubre también la caída de la propia EC2 solo si el cron corre en otro equipo.

## Qué NO se hizo
No se creó ninguna cuenta ni se guardó credencial. Si se quisiera automatizar la creación del monitor por API, se pide la clave con `infra-secrets request`, nunca por chat.

## Límite honesto
El monitor comprueba que el panel responde, no que las órdenes de energía funcionen ni que las alertas internas lleguen.

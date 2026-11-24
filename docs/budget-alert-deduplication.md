# Dedupe de avisos presupuestarios

Los avisos se identifican por la tupla `accountId`, mes de `periodStart`, `budgetName` y umbral. El mes presupuestario permanece estable cuando avanza el día del informe MonthToDate. El displayName solo acompaña el payload como texto observado.

Las claves físicas usan el prefijo `budget-v2-` y un hash de la tupla JSON. El agregado es `budget:<accountId>:<YYYY-MM>:<budgetName>`. No se trata como alias de recurso. Sin un accountId AWS válido o un período válido, el monitor no emite ni registra una entrega por nombre; tampoco sustituye valores desconocidos por cero.

No se migra la supresión legacy. event_dedup conserva únicamente dedup_key y created_at: no vincula esa clave con un evento, una cuenta física y un período. Un evento de A y una clave de otro mes creada por B con igual etiqueta no pueden combinarse como evidencia. Tampoco un evento retenido en operational_source_events establece esa vinculación. createdAt, fetchedAt y asOf no prueban el período ni la pertenencia de una clave.

Las claves, eventos y proyecciones anteriores se conservan íntegros. Una observación actual que cruce un umbral puede emitir un primer aviso físico v2 aunque exista un aviso legacy parecido. Esa nueva clave física conserva la idempotencia tras renombrar etiquetas o reiniciar SQLite. No se reemiten eventos históricos ni se consultan proveedores adicionales; las reservas de Cost Explorer permanecen intactas.

Un aviso físico v2 de 100 registra también la supresión física de 80 para esa cuenta, presupuesto y mes. La clave de 80 representa supersesión, no una afirmación de entrega separada. Las claves v2 existentes siguen siendo idempotentes.

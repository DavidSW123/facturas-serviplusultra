require('dotenv').config(); // Carga tu archivo secreto .env
const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { createClient } = require('@libsql/client'); // El nuevo traductor para Turso

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({limit: '10mb'})); 

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/bbdd', (req, res) => res.sendFile(path.join(__dirname, 'bbdd.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// --- CONEXIÓN A TURSO ---
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function inicializarDB() {
    try {
        console.log('🔄 Conectando a Turso...');
        await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, rol TEXT NOT NULL, foto TEXT DEFAULT '')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS ordenes_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_ot TEXT UNIQUE NOT NULL, fecha_encargo TEXT, fecha_completada TEXT, horas REAL, num_tecnicos INTEGER, marca TEXT, tipo_urgencia TEXT, materiales_precio REAL, estado TEXT DEFAULT 'PENDIENTE')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS facturas (id INTEGER PRIMARY KEY AUTOINCREMENT, ot_id INTEGER, base_imponible REAL, iva REAL, total REAL, qr_data TEXT, fecha_emision TEXT, FOREIGN KEY (ot_id) REFERENCES ordenes_trabajo (id))`);
        await db.execute(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, accion TEXT, referencia TEXT, datos TEXT, estado TEXT, fecha TEXT)`);

        const res = await db.execute("SELECT count(*) as count FROM usuarios");
        if (res.rows[0].count === 0) {
            await db.execute(`INSERT INTO usuarios (username, password, rol) VALUES ('Giancarlo', 'gian123', 'admin'), ('David', 'dav123', 'director'), ('Kevin', 'kev123', 'director')`);
            console.log('🔐 Usuarios jefe creados en la nube.');
        }
        console.log('✅ Base de datos Turso conectada y lista.');
    } catch (error) {
        console.error('❌ Error al conectar con Turso:', error);
    }
}
inicializarDB();

async function registrarLog(usuario, accion, referencia, datos, estado) {
    const fecha = new Date().toLocaleString('es-ES');
    try {
        await db.execute({
            sql: `INSERT INTO logs (usuario, accion, referencia, datos, estado, fecha) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [usuario, accion, referencia, JSON.stringify(datos), estado, fecha]
        });
    } catch (e) { console.error(e); }
}

function validarOT(datos) {
    const year = new Date().getFullYear().toString().slice(-2);
    const prefijo = `OT${year}/`;
    if (!datos.codigo_ot.startsWith(prefijo)) return `El código debe empezar obligatoriamente por ${prefijo}`;
    if (datos.fecha_completada) {
        if (new Date(datos.fecha_completada) <= new Date(datos.fecha_encargo)) return "La fecha de finalización debe ser posterior a la de inicio.";
    }
    return null;
}

// --- RUTAS API USUARIOS ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const r = await db.execute({ sql: `SELECT username, rol, foto FROM usuarios WHERE username = ? AND password = ?`, args: [username, password] });
        if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        const user = r.rows[0];
        res.json({ mensaje: 'Login exitoso', username: user.username, rol: user.rol, foto: user.foto });
    } catch (e) { res.status(500).json({ error: 'Error del servidor' }); }
});

app.put('/api/usuarios/foto', async (req, res) => {
    try {
        await db.execute({ sql: `UPDATE usuarios SET foto = ? WHERE username = ?`, args: [req.body.foto, req.body.username] });
        res.json({ mensaje: 'Foto actualizada' });
    } catch (e) { res.status(500).json({ error: 'Error al guardar foto' }); }
});

app.put('/api/usuarios/password', async (req, res) => {
    const { username, oldPass, newPass } = req.body;
    try {
        const r = await db.execute({ sql: `SELECT id FROM usuarios WHERE username = ? AND password = ?`, args: [username, oldPass] });
        if (r.rows.length === 0) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
        await db.execute({ sql: `UPDATE usuarios SET password = ? WHERE username = ?`, args: [newPass, username] });
        res.json({ mensaje: 'Contraseña cambiada con éxito' });
    } catch (e) { res.status(500).json({ error: 'Error al cambiar clave' }); }
});

app.post('/api/usuarios/tecnico', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'No tienes permisos' });
    try {
        await db.execute({ sql: `INSERT INTO usuarios (username, password, rol) VALUES (?, ?, 'tecnico')`, args: [req.body.username, req.body.password] });
        res.json({ mensaje: 'Técnico creado' });
    } catch (e) { res.status(500).json({ error: 'El nombre ya existe' }); }
});

// --- RUTAS API OTs ---
app.post('/api/ot', async (req, res) => {
    const rol = req.headers['x-rol'];
    const user = req.headers['x-user'];
    const datos = req.body;

    const errorValidacion = validarOT(datos);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    if (rol === 'director') {
        await registrarLog(user, 'Añadir OT', datos.codigo_ot, datos, 'PENDIENTE');
        return res.json({ mensaje: 'OT enviada a Giancarlo para su aprobación.' });
    }

    const estadoInicial = datos.fecha_completada ? 'HECHO' : 'PENDIENTE';
    try {
        const r = await db.execute({
            sql: `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estadoInicial]
        });
        await registrarLog(user, 'Añadir OT', `OT añadida: ${datos.codigo_ot}`, datos, 'APROBADO');
        res.json({ mensaje: 'OT guardada', id: Number(r.lastInsertRowid) });
    } catch (e) { res.status(500).json({ error: 'El código de OT ya existe.' }); }
});

app.get('/api/ot', async (req, res) => {
    try {
        const r = await db.execute("SELECT * FROM ordenes_trabajo ORDER BY id DESC");
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: 'Error al obtener OTs' }); }
});

app.put('/api/ot/:id/estado', async (req, res) => {
    const rol = req.headers['x-rol']; const user = req.headers['x-user'];
    const { estado } = req.body; const { id } = req.params;

    if (rol === 'director') {
        await registrarLog(user, 'Editar OT', `Cambio de estado OT ID: ${id}`, { id: id, nuevoEstado: estado }, 'PENDIENTE');
        return res.json({ mensaje: 'Cambio de estado enviado a Giancarlo para aprobación.' });
    }
    try {
        await db.execute({ sql: `UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, args: [estado, id] });
        await registrarLog(user, 'Editar OT', `Estado cambiado en OT ID: ${id}`, { id: id, nuevoEstado: estado }, 'APROBADO');
        res.json({ mensaje: 'Estado actualizado' });
    } catch (e) { res.status(500).json({ error: 'Error al cambiar estado' }); }
});

app.delete('/api/ot/:id', async (req, res) => {
    const rol = req.headers['x-rol']; const user = req.headers['x-user']; const { id } = req.params;

    if (rol === 'director') {
        await registrarLog(user, 'Eliminar OT', `Petición borrado OT ID: ${id}`, { id: id }, 'PENDIENTE');
        return res.json({ mensaje: 'Petición de borrado enviada a Giancarlo.' });
    }
    if (rol !== 'admin') return res.status(403).json({ error: 'No tienes permisos.' });

    try {
        await db.execute({ sql: `DELETE FROM ordenes_trabajo WHERE id = ?`, args: [id] });
        await registrarLog(user, 'Eliminar OT', `OT ID: ${id} eliminada`, { id: id }, 'APROBADO');
        res.json({ mensaje: 'OT eliminada correctamente' });
    } catch (e) { res.status(500).json({ error: 'Error al borrar' }); }
});

// --- RUTAS API LOGS (AUDITORÍA) ---
app.get('/api/logs', async (req, res) => {
    const r = await db.execute("SELECT * FROM logs ORDER BY id DESC");
    res.json(r.rows);
});

app.put('/api/logs/:id', async (req, res) => {
    const { id } = req.params; const { nuevosDatos } = req.body;
    if (nuevosDatos.codigo_ot) {
        const errorValidacion = validarOT(nuevosDatos);
        if (errorValidacion) return res.status(400).json({ error: errorValidacion });
    }
    try {
        await db.execute({ sql: `UPDATE logs SET datos = ? WHERE id = ?`, args: [JSON.stringify(nuevosDatos), id] });
        res.json({ mensaje: 'Petición en standby actualizada correctamente.' });
    } catch (e) { res.status(500).json({ error: 'Error al actualizar' }); }
});

app.put('/api/logs/:id/resolver', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo puede aprobar esto.' });
    const { id } = req.params; const { resolucion, motivo } = req.body;

    try {
        const rLog = await db.execute({ sql: `SELECT * FROM logs WHERE id = ?`, args: [id] });
        if (rLog.rows.length === 0) return res.status(404).json({ error: 'Log no encontrado' });
        const log = rLog.rows[0];

        if (resolucion === 'RECHAZADO') {
            await db.execute({ sql: `UPDATE logs SET estado = 'RECHAZADO', referencia = ? WHERE id = ?`, args: [`RECHAZADO por Giancarlo. Motivo: ${motivo}`, id] });
            return res.json({ mensaje: 'Petición rechazada' });
        }

        const datos = JSON.parse(log.datos);
        if (log.accion === 'Añadir OT') {
            const estadoInicial = datos.fecha_completada ? 'HECHO' : 'PENDIENTE';
            await db.execute({
                sql: `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estadoInicial]
            });
        } 
        else if (log.accion === 'Eliminar OT') {
            await db.execute({ sql: `DELETE FROM ordenes_trabajo WHERE id = ?`, args: [datos.id] });
        }
        else if (log.accion === 'Editar OT') {
            await db.execute({ sql: `UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, args: [datos.nuevoEstado, datos.id] });
        }
        await db.execute({ sql: `UPDATE logs SET estado = 'APROBADO', referencia = ? WHERE id = ?`, args: [`APROBADO por Giancarlo`, id] });
        res.json({ mensaje: 'Petición aprobada y ejecutada' });
    } catch (e) { res.status(500).json({ error: 'Error al ejecutar la acción. Posiblemente el código de OT ya exista.' }); }
});

app.post('/api/factura', async (req, res) => {
    const { ot_id, codigo_ot, base_imponible, iva, total } = req.body;
    const fecha_emision = new Date().toISOString().split('T')[0];
    const textoQR = `NIF:B-12345678|FacturaRef:${codigo_ot}|Fecha:${fecha_emision}|Total:${total}EUR`;
    try {
        const qr_imagen = await QRCode.toDataURL(textoQR);
        await db.execute({ sql: `INSERT INTO facturas (ot_id, base_imponible, iva, total, qr_data, fecha_emision) VALUES (?, ?, ?, ?, ?, ?)`, args: [ot_id, base_imponible, iva, total, qr_imagen, fecha_emision] });
        res.status(200).json({ mensaje: '¡Factura emitida!', qr_data: qr_imagen });
    } catch (e) { res.status(500).json({ error: 'Error QR.' }); }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en el puerto ${PORT}`));
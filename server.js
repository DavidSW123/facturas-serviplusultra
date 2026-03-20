require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({limit: '10mb'})); 
app.use(express.static(__dirname)); 

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/bbdd', (req, res) => res.sendFile(path.join(__dirname, 'bbdd.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// --- CONEXIÓN A LA NUBE (TURSO) ---
const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
});

async function inicializarDB() {
    try {
        console.log('🔄 Conectando a Turso en la nube...');
        await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, rol TEXT NOT NULL, foto TEXT DEFAULT '')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS ordenes_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_ot TEXT UNIQUE NOT NULL, fecha_encargo TEXT, fecha_completada TEXT, horas REAL, num_tecnicos INTEGER, marca TEXT, tipo_urgencia TEXT, materiales_precio REAL, estado TEXT DEFAULT 'PENDIENTE')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS facturas (id INTEGER PRIMARY KEY AUTOINCREMENT, ot_id INTEGER, base_imponible REAL, iva REAL, total REAL, qr_data TEXT, fecha_emision TEXT, FOREIGN KEY (ot_id) REFERENCES ordenes_trabajo (id))`);
        await db.execute(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, accion TEXT, referencia TEXT, datos TEXT, estado TEXT, fecha TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, nif TEXT, direccion TEXT, email TEXT, telefono TEXT, logo TEXT, estado TEXT DEFAULT 'PENDIENTE')`);
        
        // Comprobar y añadir columnas nuevas si no existen (Manejo de errores silencioso)
        try { await db.execute(`ALTER TABLE ordenes_trabajo ADD COLUMN cliente_id INTEGER`); } catch (e) { /* La columna ya existe */ }
        try { await db.execute(`ALTER TABLE ordenes_trabajo ADD COLUMN tecnicos_nombres TEXT DEFAULT ''`); } catch (e) { /* La columna ya existe */ }

        const res = await db.execute("SELECT count(*) as count FROM usuarios");
        if (res.rows[0].count === 0) {
            await db.execute(`INSERT INTO usuarios (username, password, rol) VALUES ('Giancarlo', 'gian123', 'admin'), ('David', 'dav123', 'director'), ('Kevin', 'kev123', 'director')`);
            console.log('🔐 Usuarios jefe creados.');
        }
        console.log('✅ Base de datos Turso conectada y 100% operativa.');
    } catch (error) { console.error('❌ Error al inicializar Turso:', error); }
}
inicializarDB();

async function registrarLog(usuario, accion, referencia, datos, estado) {
    const fecha = new Date().toLocaleString('es-ES');
    try { await db.execute({ sql: `INSERT INTO logs (usuario, accion, referencia, datos, estado, fecha) VALUES (?, ?, ?, ?, ?, ?)`, args: [usuario, accion, referencia, JSON.stringify(datos), estado, fecha] }); } catch (e) { console.error('Error guardando log:', e); }
}

function validarOT(datos) {
    const year = new Date().getFullYear().toString().slice(-2);
    const prefijo = `OT${year}/`;
    if (!datos.codigo_ot.startsWith(prefijo)) return `El código debe empezar por ${prefijo}`;
    if (datos.fecha_completada && new Date(datos.fecha_completada) <= new Date(datos.fecha_encargo)) return "Finalización debe ser posterior a inicio.";
    return null;
}

// --- API USUARIOS ---
app.post('/api/login', async (req, res) => {
    const r = await db.execute({ sql: `SELECT username, rol, foto FROM usuarios WHERE username = ? AND password = ?`, args: [req.body.username, req.body.password] });
    if (r.rows.length === 0) return res.status(401).json({ error: 'Credenciales incorrectas' });
    res.json({ mensaje: 'Login exitoso', username: r.rows[0].username, rol: r.rows[0].rol, foto: r.rows[0].foto });
});
app.put('/api/usuarios/foto', async (req, res) => {
    await db.execute({ sql: `UPDATE usuarios SET foto = ? WHERE username = ?`, args: [req.body.foto, req.body.username] });
    res.json({ mensaje: 'Foto actualizada' });
});
app.put('/api/usuarios/password', async (req, res) => {
    const r = await db.execute({ sql: `SELECT id FROM usuarios WHERE username = ? AND password = ?`, args: [req.body.username, req.body.oldPass] });
    if (r.rows.length === 0) return res.status(400).json({ error: 'Clave actual incorrecta' });
    await db.execute({ sql: `UPDATE usuarios SET password = ? WHERE username = ?`, args: [req.body.newPass, req.body.username] });
    res.json({ mensaje: 'Contraseña cambiada' });
});
app.post('/api/usuarios/tecnico', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'Sin permisos' });
    try { await db.execute({ sql: `INSERT INTO usuarios (username, password, rol) VALUES (?, ?, 'tecnico')`, args: [req.body.username, req.body.password] }); res.json({ mensaje: 'Técnico creado' }); } catch (e) { res.status(500).json({ error: 'El usuario ya existe' }); }
});
app.get('/api/usuarios/nombres', async (req, res) => {
    try { const r = await db.execute("SELECT username, rol FROM usuarios ORDER BY rol, username"); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// --- API CLIENTES (CRM) ---
app.get('/api/clientes', async (req, res) => {
    try { const r = await db.execute("SELECT * FROM clientes ORDER BY nombre ASC"); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.post('/api/clientes', async (req, res) => {
    const rol = req.headers['x-rol'];
    const estado = rol === 'admin' ? 'APROBADO' : 'PENDIENTE';
    const { nombre, nif, direccion, email, telefono, logo } = req.body;
    try {
        await db.execute({ sql: `INSERT INTO clientes (nombre, nif, direccion, email, telefono, logo, estado) VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [nombre, nif, direccion, email, telefono, logo || '', estado] });
        res.json({ mensaje: estado === 'APROBADO' ? 'Cliente añadido a la BBDD' : 'Petición enviada a Giancarlo para revisión.' });
    } catch (e) { res.status(500).json({ error: 'Error al crear cliente' }); }
});
app.put('/api/clientes/:id/estado', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo puede aprobar' });
    try {
        await db.execute({ sql: `UPDATE clientes SET estado = ? WHERE id = ?`, args: [req.body.estado, req.params.id] });
        res.json({ mensaje: `Cliente ${req.body.estado}` });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// --- API OTs ---
app.post('/api/ot', async (req, res) => {
    const rol = req.headers['x-rol']; const user = req.headers['x-user']; const datos = req.body;
    const err = validarOT(datos); if (err) return res.status(400).json({ error: err });

    if (rol === 'director') {
        await registrarLog(user, 'Añadir OT', datos.codigo_ot, datos, 'PENDIENTE');
        return res.json({ mensaje: 'OT enviada a Giancarlo para su aprobación.' });
    }
    const estado = datos.fecha_completada ? 'HECHO' : 'PENDIENTE';
    try {
        const r = await db.execute({ 
            sql: `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado, cliente_id, tecnicos_nombres) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
            args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estado, datos.cliente_id || null, datos.tecnicos_nombres || ''] 
        });
        await registrarLog(user, 'Añadir OT', `OT: ${datos.codigo_ot}`, datos, 'APROBADO');
        res.json({ mensaje: 'OT guardada', id: Number(r.lastInsertRowid) });
    } catch (e) { 
        console.error("❌ ERROR CRÍTICO GUARDANDO OT EN TURSO:", e);
        res.status(500).json({ error: 'Error al guardar en la nube. Revisa la consola de Render.' }); 
    }
});
app.get('/api/ot', async (req, res) => {
    try { const r = await db.execute("SELECT * FROM ordenes_trabajo ORDER BY id DESC"); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.put('/api/ot/:id/estado', async (req, res) => {
    const rol = req.headers['x-rol']; const user = req.headers['x-user']; const { estado } = req.body; const { id } = req.params;
    if (rol === 'director') {
        await registrarLog(user, 'Editar OT', `Cambio estado OT ID: ${id}`, { id, nuevoEstado: estado }, 'PENDIENTE'); return res.json({ mensaje: 'Petición enviada a Giancarlo.' });
    }
    try {
        await db.execute({ sql: `UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, args: [estado, id] });
        await registrarLog(user, 'Editar OT', `Estado cambiado OT: ${id}`, { id, nuevoEstado: estado }, 'APROBADO'); res.json({ mensaje: 'Estado actualizado' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});
app.delete('/api/ot/:id', async (req, res) => {
    const rol = req.headers['x-rol']; const user = req.headers['x-user']; const { id } = req.params;
    if (rol === 'director') {
        await registrarLog(user, 'Eliminar OT', `Borrado OT ID: ${id}`, { id }, 'PENDIENTE'); return res.json({ mensaje: 'Petición enviada a Giancarlo.' });
    }
    if (rol !== 'admin') return res.status(403).json({ error: 'Sin permisos.' });
    try {
        await db.execute({ sql: `DELETE FROM ordenes_trabajo WHERE id = ?`, args: [id] }); await registrarLog(user, 'Eliminar OT', `OT: ${id} eliminada`, { id }, 'APROBADO'); res.json({ mensaje: 'Eliminada' });
    } catch (e) { res.status(500).json({ error: 'Error' }); }
});

// --- API LOGS & FACTURA ---
app.get('/api/logs', async (req, res) => { const r = await db.execute("SELECT * FROM logs ORDER BY id DESC"); res.json(r.rows); });
app.put('/api/logs/:id', async (req, res) => {
    if (req.body.nuevosDatos.codigo_ot) { const err = validarOT(req.body.nuevosDatos); if (err) return res.status(400).json({ error: err }); }
    await db.execute({ sql: `UPDATE logs SET datos = ? WHERE id = ?`, args: [JSON.stringify(req.body.nuevosDatos), req.params.id] }); res.json({ mensaje: 'Petición actualizada.' });
});
app.put('/api/logs/:id/resolver', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo.' });
    const { id } = req.params; const { resolucion, motivo } = req.body;
    try {
        const rLog = await db.execute({ sql: `SELECT * FROM logs WHERE id = ?`, args: [id] });
        if (rLog.rows.length === 0) return res.status(404).json({ error: 'Log no encontrado' });
        const log = rLog.rows[0];
        if (resolucion === 'RECHAZADO') { await db.execute({ sql: `UPDATE logs SET estado = 'RECHAZADO', referencia = ? WHERE id = ?`, args: [`Rechazado: ${motivo}`, id] }); return res.json({ mensaje: 'Rechazada' }); }
        
        const datos = JSON.parse(log.datos);
        if (log.accion === 'Añadir OT') {
            const estado = datos.fecha_completada ? 'HECHO' : 'PENDIENTE';
            await db.execute({ sql: `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado, cliente_id, tecnicos_nombres) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estado, datos.cliente_id || null, datos.tecnicos_nombres || ''] });
        } else if (log.accion === 'Eliminar OT') { await db.execute({ sql: `DELETE FROM ordenes_trabajo WHERE id = ?`, args: [datos.id] });
        } else if (log.accion === 'Editar OT') { await db.execute({ sql: `UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, args: [datos.nuevoEstado, datos.id] }); }
        
        await db.execute({ sql: `UPDATE logs SET estado = 'APROBADO', referencia = ? WHERE id = ?`, args: [`APROBADO`, id] }); res.json({ mensaje: 'Petición ejecutada' });
    } catch (e) { console.error('Error al resolver:', e); res.status(500).json({ error: 'Error ejecutando acción.' }); }
});

app.post('/api/factura', async (req, res) => {
    const { ot_id, codigo_ot, base_imponible, iva, total } = req.body;
    const fecha = new Date().toISOString().split('T')[0];
    const txt = `NIF:B-26892760|FacturaRef:${codigo_ot}|Fecha:${fecha}|Total:${total}EUR`;
    try {
        const qr = await QRCode.toDataURL(txt);
        await db.execute({ sql: `INSERT INTO facturas (ot_id, base_imponible, iva, total, qr_data, fecha_emision) VALUES (?, ?, ?, ?, ?, ?)`, args: [ot_id, base_imponible, iva, total, qr, fecha] });
        res.status(200).json({ mensaje: 'Factura emitida', qr_data: qr });
    } catch (e) { res.status(500).json({ error: 'Error QR.' }); }
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en el puerto ${PORT}`));
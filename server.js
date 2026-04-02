require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({limit: '50mb'})); 
app.use(express.static(__dirname)); 

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/bbdd', (req, res) => res.sendFile(path.join(__dirname, 'bbdd.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

async function inicializarDB() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, rol TEXT NOT NULL, foto TEXT DEFAULT '')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS ordenes_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_ot TEXT UNIQUE NOT NULL, fecha_encargo TEXT, fecha_completada TEXT, horas REAL, num_tecnicos INTEGER, marca TEXT, tipo_urgencia TEXT, materiales_precio REAL, estado TEXT DEFAULT 'PENDIENTE')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS facturas (id INTEGER PRIMARY KEY AUTOINCREMENT, ot_id INTEGER, base_imponible REAL, iva REAL, total REAL, qr_data TEXT, fecha_emision TEXT, FOREIGN KEY (ot_id) REFERENCES ordenes_trabajo (id))`);
        await db.execute(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, accion TEXT, referencia TEXT, datos TEXT, estado TEXT, fecha TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS clientes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, nif TEXT, direccion TEXT, email TEXT, telefono TEXT, logo TEXT, estado TEXT DEFAULT 'PENDIENTE')`);
        await db.execute(`CREATE TABLE IF NOT EXISTS ot_adjuntos (id INTEGER PRIMARY KEY AUTOINCREMENT, ot_id INTEGER, imagen TEXT NOT NULL, importe REAL DEFAULT 0, descripcion TEXT, fecha TEXT)`);
        await db.execute(`CREATE TABLE IF NOT EXISTS gastos_socios (id INTEGER PRIMARY KEY AUTOINCREMENT, pagador TEXT NOT NULL, concepto TEXT, importe REAL, fecha TEXT)`);
        
        // 🔴 NUEVA TABLA: STOCK DE MATERIALES 🔴
        await db.execute(`CREATE TABLE IF NOT EXISTS stock_materiales (id INTEGER PRIMARY KEY AUTOINCREMENT, descripcion TEXT NOT NULL, cantidad REAL NOT NULL, precio_unidad REAL NOT NULL, imagen TEXT, fecha TEXT)`);

        try { await db.execute(`ALTER TABLE ordenes_trabajo ADD COLUMN cliente_id INTEGER`); } catch (e) { }
        try { await db.execute(`ALTER TABLE ordenes_trabajo ADD COLUMN tecnicos_nombres TEXT DEFAULT ''`); } catch (e) { }
        try { await db.execute(`ALTER TABLE gastos_socios ADD COLUMN implicados TEXT DEFAULT 'Giancarlo,David,Kevin'`); } catch (e) { }

        const res = await db.execute("SELECT count(*) as count FROM usuarios");
        if (res.rows[0].count === 0) { await db.execute(`INSERT INTO usuarios (username, password, rol) VALUES ('Giancarlo', 'gian123', 'admin'), ('David', 'dav123', 'director'), ('Kevin', 'kev123', 'director')`); }
        console.log('✅ Base de datos Turso conectada y 100% operativa (Con Módulo de Stock).');
    } catch (error) { console.error('❌ Error Turso:', error); }
}
inicializarDB();

async function registrarLog(u, a, r, d, e) { const f = new Date().toLocaleString('es-ES'); try { await db.execute({ sql: `INSERT INTO logs (usuario, accion, referencia, datos, estado, fecha) VALUES (?, ?, ?, ?, ?, ?)`, args: [u, a, r, JSON.stringify(d), e, f] }); } catch (er) { console.error(er); } }
function validarOT(d) { const y = new Date().getFullYear().toString().slice(-2); const p = `OT${y}/`; if (!d.codigo_ot.startsWith(p)) return `Debe empezar por ${p}`; if (d.fecha_completada && new Date(d.fecha_completada) <= new Date(d.fecha_encargo)) return "Finalización posterior a inicio."; return null; }

app.post('/api/login', async (req, res) => { try { const r = await db.execute({ sql: `SELECT username, rol, foto FROM usuarios WHERE username = ? AND password = ?`, args: [req.body.username, req.body.password] }); if (r.rows.length === 0) return res.status(401).json({ error: 'Credenciales incorrectas' }); res.json({ mensaje: 'Login exitoso', username: r.rows[0].username, rol: r.rows[0].rol, foto: r.rows[0].foto }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.put('/api/usuarios/foto', async (req, res) => { await db.execute({ sql: `UPDATE usuarios SET foto = ? WHERE username = ?`, args: [req.body.foto, req.body.username] }); res.json({ mensaje: 'Foto actualizada' }); });
app.put('/api/usuarios/password', async (req, res) => { const r = await db.execute({ sql: `SELECT id FROM usuarios WHERE username = ? AND password = ?`, args: [req.body.username, req.body.oldPass] }); if (r.rows.length === 0) return res.status(400).json({ error: 'Clave actual incorrecta' }); await db.execute({ sql: `UPDATE usuarios SET password = ? WHERE username = ?`, args: [req.body.newPass, req.body.username] }); res.json({ mensaje: 'Contraseña cambiada' }); });
app.post('/api/usuarios/tecnico', async (req, res) => { if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'Sin permisos' }); try { await db.execute({ sql: `INSERT INTO usuarios (username, password, rol) VALUES (?, ?, 'tecnico')`, args: [req.body.username, req.body.password] }); res.json({ mensaje: 'Técnico creado' }); } catch (e) { res.status(500).json({ error: 'El usuario ya existe' }); } });
app.get('/api/usuarios/nombres', async (req, res) => { try { const r = await db.execute("SELECT username, rol FROM usuarios ORDER BY rol, username"); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.get('/api/clientes', async (req, res) => { try { const r = await db.execute("SELECT * FROM clientes ORDER BY nombre ASC"); res.json(r.rows); } catch (e) { res.status(500).json({ error: 'Error' }); } });
app.post('/api/clientes', async (req, res) => { const rol = req.headers['x-rol']; const estado = rol === 'admin' ? 'APROBADO' : 'PENDIENTE'; const { nombre, nif, direccion, email, telefono, logo } = req.body; try { await db.execute({ sql: `INSERT INTO clientes (nombre, nif, direccion, email, telefono, logo, estado) VALUES (?, ?, ?, ?, ?, ?, ?)`, args: [nombre, nif, direccion, email, telefono, logo || '', estado] }); res.json({ mensaje: estado === 'APROBADO' ? 'Cliente añadido a la BBDD' : 'Petición enviada a Giancarlo' }); } catch (e) { res.status(500).json({ error: 'Error al crear cliente' }); } });
app.put('/api/clientes/:id/estado', async (req, res) => { if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo puede aprobar' }); try { await db.execute({ sql: `UPDATE clientes SET estado = ? WHERE id = ?`, args: [req.body.estado, req.params.id] }); res.json({ mensaje: `Cliente ${req.body.estado}` }); } catch (e) { res.status(500).json({ error: 'Error' }); } });

// 🔴 MODIFICADA LA CREACIÓN DE OT PARA PROCESAR LOS MATERIALES EN CASCADA 🔴
app.post('/api/ot', async (req, res) => { 
    const rol = req.headers['x-rol']; const user = req.headers['x-user']; const datos = req.body; const err = validarOT(datos); if (err) return res.status(400).json({ error: err }); 
    
    // Calcular el total de materiales que vienen del formulario avanzado
    let totalMateriales = 0;
    if (datos.lineas_materiales && datos.lineas_materiales.length > 0) {
        totalMateriales = datos.lineas_materiales.reduce((acc, curr) => acc + curr.importe, 0);
    }
    datos.materiales_precio = totalMateriales; // Sobrescribimos con lo real calculado

    if (rol === 'director') { 
        await registrarLog(user, 'Añadir OT', datos.codigo_ot, datos, 'PENDIENTE'); 
        return res.json({ mensaje: 'OT enviada a Giancarlo para su aprobación.' }); 
    } 

    const estado = datos.fecha_completada ? 'HECHO' : 'PENDIENTE'; 
    try { 
        const r = await db.execute({ sql: `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado, cliente_id, tecnicos_nombres) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada || null, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estado, datos.cliente_id || null, datos.tecnicos_nombres || ''] }); 
        const newOtId = Number(r.lastInsertRowid);

        // Si trae materiales, los insertamos como adjuntos y restamos stock si toca
        if (datos.lineas_materiales && datos.lineas_materiales.length > 0) {
            const fMat = new Date().toLocaleString('es-ES');
            for (let mat of datos.lineas_materiales) {
                let textoDesc = mat.is_stock ? `[STOCK] ${mat.descripcion} (Cant: ${mat.cantidad})` : `${mat.descripcion} (Cant: ${mat.cantidad})`;
                await db.execute({ sql: `INSERT INTO ot_adjuntos (ot_id, imagen, importe, descripcion, fecha) VALUES (?, ?, ?, ?, ?)`, args: [newOtId, mat.imagen || '', mat.importe, textoDesc, fMat] });
                
                if (mat.is_stock && mat.stock_id) {
                    await db.execute({ sql: `UPDATE stock_materiales SET cantidad = cantidad - ? WHERE id = ?`, args: [mat.cantidad, mat.stock_id] });
                }
            }
        }

        await registrarLog(user, 'Añadir OT', `OT: ${datos.codigo_ot}`, datos, 'APROBADO'); 
        res.json({ mensaje: 'OT y materiales guardados correctamente.', id: newOtId }); 
    } catch (e) { 
        if (e.message && e.message.includes('UNIQUE')) { res.status(400).json({ error: 'Ese código de OT ya está registrado.' }); } 
        else { res.status(500).json({ error: `Fallo: ${e.message}` }); } 
    } 
});

app.get('/api/ot', async (req, res) => { try { const r = await db.execute("SELECT * FROM ordenes_trabajo ORDER BY id DESC"); res.json(r.rows); } catch (e) { res.status(500).json({ error: `Fallo: ${e.message}` }); } });
app.put('/api/ot/:id/estado', async (req, res) => { const rol = req.headers['x-rol']; const user = req.headers['x-user']; const { estado } = req.body; const { id } = req.params; if (rol === 'director') { await registrarLog(user, 'Editar OT', `Cambio estado OT ID: ${id}`, { id, nuevoEstado: estado }, 'PENDIENTE'); return res.json({ mensaje: 'Petición enviada a Giancarlo.' }); } try { await db.execute({ sql: `UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, args: [estado, id] }); await registrarLog(user, 'Editar OT', `Estado cambiado OT: ${id}`, { id, nuevoEstado: estado }, 'APROBADO'); res.json({ mensaje: 'Estado actualizado' }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.put('/api/ot/:id', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo puede editar una OT.' });
    const { id } = req.params; const datos = req.body; const err = validarOT(datos); if (err) return res.status(400).json({ error: err });
    try { await db.execute({ sql: `UPDATE ordenes_trabajo SET codigo_ot = ?, fecha_encargo = ?, fecha_completada = ?, horas = ?, num_tecnicos = ?, marca = ?, tipo_urgencia = ?, cliente_id = ?, tecnicos_nombres = ? WHERE id = ?`, args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada || null, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.cliente_id || null, datos.tecnicos_nombres || '', id] }); await registrarLog(req.headers['x-user'], 'Editar OT', `OT: ${datos.codigo_ot} modificada directamente`, datos, 'APROBADO'); res.json({ mensaje: '✅ Orden de Trabajo actualizada con éxito.' }); } 
    catch (e) { if (e.message && e.message.includes('UNIQUE')) res.status(400).json({ error: 'Ese código de OT ya está registrado.' }); else res.status(500).json({ error: e.message }); }
});

app.delete('/api/ot/:id', async (req, res) => { const rol = req.headers['x-rol']; const user = req.headers['x-user']; const { id } = req.params; if (rol === 'director') { await registrarLog(user, 'Eliminar OT', `Borrado OT ID: ${id}`, { id }, 'PENDIENTE'); return res.json({ mensaje: 'Petición enviada a Giancarlo.' }); } if (rol !== 'admin') return res.status(403).json({ error: 'Sin permisos.' }); try { await db.execute({ sql: `DELETE FROM facturas WHERE ot_id = ?`, args: [id] }); await db.execute({ sql: `DELETE FROM ot_adjuntos WHERE ot_id = ?`, args: [id] }); await db.execute({ sql: `DELETE FROM ordenes_trabajo WHERE id = ?`, args: [id] }); await registrarLog(user, 'Eliminar OT', `OT: ${id} eliminada`, { id }, 'APROBADO'); res.json({ mensaje: 'Eliminada' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/ot/:id/adjuntos', async (req, res) => { try { const r = await db.execute({ sql: "SELECT * FROM ot_adjuntos WHERE ot_id = ? ORDER BY id DESC", args: [req.params.id] }); res.json(r.rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/ot/:id/adjuntos', async (req, res) => { const ot_id = req.params.id; const { imagen, importe, descripcion } = req.body; const fecha = new Date().toLocaleString('es-ES'); try { await db.execute({ sql: `INSERT INTO ot_adjuntos (ot_id, imagen, importe, descripcion, fecha) VALUES (?, ?, ?, ?, ?)`, args: [ot_id, imagen, parseFloat(importe) || 0, descripcion || '', fecha] }); if (parseFloat(importe) > 0) { await db.execute({ sql: `UPDATE ordenes_trabajo SET materiales_precio = materiales_precio + ? WHERE id = ?`, args: [parseFloat(importe), ot_id] }); } res.json({ mensaje: 'Ticket guardado y materiales sumados.' }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/logs', async (req, res) => { try { const r = await db.execute("SELECT * FROM logs ORDER BY id DESC"); res.json(r.rows); } catch(e) { res.status(500).json({ error: e.message }); } });
app.put('/api/logs/:id', async (req, res) => { if (req.body.nuevosDatos.codigo_ot) { const err = validarOT(req.body.nuevosDatos); if (err) return res.status(400).json({ error: err }); } await db.execute({ sql: `UPDATE logs SET datos = ? WHERE id = ?`, args: [JSON.stringify(req.body.nuevosDatos), req.params.id] }); res.json({ mensaje: 'Petición actualizada.' }); });

// 🔴 RESOLUCIÓN DEL LOG TAMBIÉN PROCESA MATERIALES SI EL DIRECTOR LA PUSO EN ESPERA 🔴
app.put('/api/logs/:id/resolver', async (req, res) => {
    if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo.' });
    const { id } = req.params; const { resolucion, motivo } = req.body;
    try {
        const rLog = await db.execute({ sql: `SELECT * FROM logs WHERE id = ?`, args: [id] }); if (rLog.rows.length === 0) return res.status(404).json({ error: 'Log no encontrado' }); const log = rLog.rows[0];
        if (resolucion === 'RECHAZADO') { await db.execute({ sql: `UPDATE logs SET estado = 'RECHAZADO', referencia = ? WHERE id = ?`, args: [`Rechazado: ${motivo}`, id] }); return res.json({ mensaje: 'Rechazada' }); }
        const datos = JSON.parse(log.datos);
        if (log.accion === 'Añadir OT') { 
            const estado = datos.fecha_completada ? 'HECHO' : 'PENDIENTE'; 
            const rIn = await db.execute({ sql: `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado, cliente_id, tecnicos_nombres) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, args: [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada || null, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estado, datos.cliente_id || null, datos.tecnicos_nombres || ''] });
            
            const newOtId = Number(rIn.lastInsertRowid);
            if (datos.lineas_materiales && datos.lineas_materiales.length > 0) {
                const fMat = new Date().toLocaleString('es-ES');
                for (let mat of datos.lineas_materiales) {
                    let textoDesc = mat.is_stock ? `[STOCK] ${mat.descripcion} (Cant: ${mat.cantidad})` : `${mat.descripcion} (Cant: ${mat.cantidad})`;
                    await db.execute({ sql: `INSERT INTO ot_adjuntos (ot_id, imagen, importe, descripcion, fecha) VALUES (?, ?, ?, ?, ?)`, args: [newOtId, mat.imagen || '', mat.importe, textoDesc, fMat] });
                    if (mat.is_stock && mat.stock_id) { await db.execute({ sql: `UPDATE stock_materiales SET cantidad = cantidad - ? WHERE id = ?`, args: [mat.cantidad, mat.stock_id] }); }
                }
            }
        } else if (log.accion === 'Eliminar OT') { await db.execute({ sql: `DELETE FROM facturas WHERE ot_id = ?`, args: [datos.id] }); await db.execute({ sql: `DELETE FROM ot_adjuntos WHERE ot_id = ?`, args: [datos.id] }); await db.execute({ sql: `DELETE FROM ordenes_trabajo WHERE id = ?`, args: [datos.id] });
        } else if (log.accion === 'Editar OT') { await db.execute({ sql: `UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, args: [datos.nuevoEstado, datos.id] }); }
        await db.execute({ sql: `UPDATE logs SET estado = 'APROBADO', referencia = ? WHERE id = ?`, args: [`APROBADO`, id] }); res.json({ mensaje: 'Petición ejecutada' });
    } catch (e) { res.status(500).json({ error: `Error resolviendo: ${e.message}` }); }
});

app.post('/api/factura', async (req, res) => { const { ot_id, codigo_ot, base_imponible, iva, total } = req.body; const fecha = new Date().toISOString().split('T')[0]; const txt = `NIF:B-26892760|FacturaRef:${codigo_ot}|Fecha:${fecha}|Total:${total}EUR`; try { const qr = await QRCode.toDataURL(txt); await db.execute({ sql: `INSERT INTO facturas (ot_id, base_imponible, iva, total, qr_data, fecha_emision) VALUES (?, ?, ?, ?, ?, ?)`, args: [ot_id, base_imponible, iva, total, qr, fecha] }); res.status(200).json({ mensaje: 'Factura emitida', qr_data: qr }); } catch (e) { res.status(500).json({ error: 'Error QR.' }); } });

const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxwi8cCg4D0mGEK_Xh3V52AHMf31ESpvEbfmXgLNSw-k9GMt9_wauc3GicRqUvT9AkEow/exec";
app.post('/api/test-email', async (req, res) => { const { emailDestino } = req.body; try { const payload = { to: emailDestino, subject: "🛠️ Prueba de conexión - ServiPlusUltra", html: `<div style="text-align: center;"><h2 style="color: #1abc9c;">¡El túnel secreto funciona! 🚀</h2></div>` }; await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) }); res.json({ mensaje: 'Correo enviado con éxito. ¡Revisa tu bandeja de entrada! 😎' }); } catch (error) { res.status(500).json({ error: 'Fallo al enviar el correo por el puente.' }); } });
app.post('/api/enviar-factura', async (req, res) => { const { emailDestino, asunto, htmlBody, pdfBase64, nombreArchivo } = req.body; try { const payload = { to: emailDestino, subject: asunto, html: htmlBody, adjuntoBase64: pdfBase64, adjuntoNombre: nombreArchivo }; await fetch(GOOGLE_SCRIPT_URL, { method: 'POST', body: JSON.stringify(payload) }); res.json({ mensaje: 'Factura enviada con éxito al cliente por correo electrónico. 🚀' }); } catch (error) { res.status(500).json({ error: 'Fallo de conexión al enviar la factura.' }); } });

// --- API GASTOS SOCIOS ---
app.get('/api/gastos', async (req, res) => { if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'Sin permisos' }); try { const r = await db.execute("SELECT * FROM gastos_socios ORDER BY id DESC"); res.json(r.rows); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/gastos', async (req, res) => { if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'Sin permisos' }); const { pagador, concepto, importe, implicados } = req.body; const fecha = new Date().toLocaleString('es-ES'); const impStr = Array.isArray(implicados) ? implicados.join(',') : 'Giancarlo,David,Kevin'; try { await db.execute({ sql: `INSERT INTO gastos_socios (pagador, concepto, importe, fecha, implicados) VALUES (?, ?, ?, ?, ?)`, args: [pagador, concepto, parseFloat(importe), fecha, impStr] }); res.json({ mensaje: 'Gasto registrado correctamente.' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/gastos/:id', async (req, res) => { if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'Sin permisos' }); try { await db.execute({ sql: `DELETE FROM gastos_socios WHERE id = ?`, args: [req.params.id] }); res.json({ mensaje: 'Gasto eliminado.' }); } catch (e) { res.status(500).json({ error: e.message }); } });

// 🔴 NUEVA API: STOCK DE MATERIALES 🔴
app.get('/api/stock', async (req, res) => { 
    try { const r = await db.execute("SELECT * FROM stock_materiales ORDER BY descripcion ASC"); res.json(r.rows); } 
    catch (e) { res.status(500).json({ error: e.message }); } 
});

app.post('/api/stock', async (req, res) => { 
    const { descripcion, cantidad, precio_unidad, imagen } = req.body;
    const fecha = new Date().toLocaleString('es-ES');
    try { 
        await db.execute({ sql: `INSERT INTO stock_materiales (descripcion, cantidad, precio_unidad, imagen, fecha) VALUES (?, ?, ?, ?, ?)`, args: [descripcion, parseFloat(cantidad), parseFloat(precio_unidad), imagen || '', fecha] }); 
        res.json({ mensaje: 'Material añadido al stock.' }); 
    } catch (e) { res.status(500).json({ error: e.message }); } 
});

app.listen(PORT, () => console.log(`🚀 Servidor listo en el puerto ${PORT}`));
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({limit: '10mb'})); 

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/bbdd', (req, res) => res.sendFile(path.join(__dirname, 'bbdd.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (!err) {
        console.log('✅ Base de datos conectada.');
        db.run(`CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, rol TEXT NOT NULL, foto TEXT DEFAULT '')`);
        db.run(`CREATE TABLE IF NOT EXISTS ordenes_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo_ot TEXT UNIQUE NOT NULL, fecha_encargo TEXT, fecha_completada TEXT, horas REAL, num_tecnicos INTEGER, marca TEXT, tipo_urgencia TEXT, materiales_precio REAL, estado TEXT DEFAULT 'PENDIENTE')`);
        db.run(`CREATE TABLE IF NOT EXISTS facturas (id INTEGER PRIMARY KEY AUTOINCREMENT, ot_id INTEGER, base_imponible REAL, iva REAL, total REAL, qr_data TEXT, fecha_emision TEXT, FOREIGN KEY (ot_id) REFERENCES ordenes_trabajo (id))`);
        db.run(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT, accion TEXT, referencia TEXT, datos TEXT, estado TEXT, fecha TEXT)`);
    }
});

function registrarLog(usuario, accion, referencia, datos, estado) {
    const fecha = new Date().toLocaleString('es-ES');
    db.run(`INSERT INTO logs (usuario, accion, referencia, datos, estado, fecha) VALUES (?, ?, ?, ?, ?, ?)`, [usuario, accion, referencia, JSON.stringify(datos), estado, fecha]);
}

// === FILTRO DE SEGURIDAD (VALIDACIONES ESTRICTAS) ===
function validarOT(datos) {
    const year = new Date().getFullYear().toString().slice(-2);
    const prefijo = `OT${year}/`;
    
    if (!datos.codigo_ot.startsWith(prefijo)) {
        return `El código debe empezar obligatoriamente por ${prefijo}`;
    }
    
    if (datos.fecha_completada) {
        const inicio = new Date(datos.fecha_encargo);
        const fin = new Date(datos.fecha_completada);
        if (fin <= inicio) return "La fecha y hora de finalización debe ser posterior a la de inicio.";
    }
    return null; // Todo OK
}

// --- RUTAS API USUARIOS ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT username, rol, foto FROM usuarios WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (err || !user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        res.json({ mensaje: 'Login exitoso', username: user.username, rol: user.rol, foto: user.foto });
    });
});
app.put('/api/usuarios/foto', (req, res) => {
    const { username, foto } = req.body;
    db.run(`UPDATE usuarios SET foto = ? WHERE username = ?`, [foto, username], () => res.json({ mensaje: 'Foto actualizada' }));
});
app.put('/api/usuarios/password', (req, res) => {
    const { username, oldPass, newPass } = req.body;
    db.get(`SELECT id FROM usuarios WHERE username = ? AND password = ?`, [username, oldPass], (err, user) => {
        if (!user) return res.status(400).json({ error: 'La contraseña actual es incorrecta' });
        db.run(`UPDATE usuarios SET password = ? WHERE username = ?`, [newPass, username], () => res.json({ mensaje: 'Contraseña cambiada con éxito' }));
    });
});
app.post('/api/usuarios/tecnico', (req, res) => {
    const { username, password } = req.body;
    if (req.headers['x-rol'] !== 'admin' && req.headers['x-rol'] !== 'director') return res.status(403).json({ error: 'No tienes permisos' });
    db.run(`INSERT INTO usuarios (username, password, rol) VALUES (?, ?, 'tecnico')`, [username, password], function(err) {
        if (err) return res.status(500).json({ error: 'El nombre ya existe' });
        res.json({ mensaje: 'Técnico creado' });
    });
});

// --- RUTAS API OTs ---
app.post('/api/ot', (req, res) => {
    const rol = req.headers['x-rol'];
    const user = req.headers['x-user'];
    const datos = req.body;

    const errorValidacion = validarOT(datos);
    if (errorValidacion) return res.status(400).json({ error: errorValidacion });

    if (rol === 'director') {
        registrarLog(user, 'Añadir OT', datos.codigo_ot, datos, 'PENDIENTE');
        return res.json({ mensaje: 'OT enviada a Giancarlo para su aprobación.' });
    }

    const estadoInicial = datos.fecha_completada ? 'HECHO' : 'PENDIENTE';
    const query = `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    db.run(query, [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estadoInicial], function(err) {
        if (err) return res.status(500).json({ error: 'El código de OT ya existe en la base de datos.' }); 
        registrarLog(user, 'Añadir OT', `OT añadida: ${datos.codigo_ot}`, datos, 'APROBADO');
        res.json({ mensaje: 'OT guardada', id: this.lastID });
    });
});

app.get('/api/ot', (req, res) => db.all("SELECT * FROM ordenes_trabajo ORDER BY id DESC", [], (err, rows) => res.json(rows)));

app.put('/api/ot/:id/estado', (req, res) => {
    const rol = req.headers['x-rol'];
    const user = req.headers['x-user'];
    const { estado } = req.body;
    const { id } = req.params;

    if (rol === 'director') {
        registrarLog(user, 'Editar OT', `Cambio de estado OT ID: ${id}`, { id: id, nuevoEstado: estado }, 'PENDIENTE');
        return res.json({ mensaje: 'Cambio de estado enviado a Giancarlo para aprobación.' });
    }
    db.run(`UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, [estado, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        registrarLog(user, 'Editar OT', `Estado cambiado en OT ID: ${id}`, { id: id, nuevoEstado: estado }, 'APROBADO');
        res.json({ mensaje: 'Estado actualizado' });
    });
});

app.delete('/api/ot/:id', (req, res) => {
    const rol = req.headers['x-rol'];
    const user = req.headers['x-user'];
    const { id } = req.params;

    if (rol === 'director') {
        registrarLog(user, 'Eliminar OT', `Petición borrado OT ID: ${id}`, { id: id }, 'PENDIENTE');
        return res.json({ mensaje: 'Petición de borrado enviada a Giancarlo.' });
    }
    if (rol !== 'admin') return res.status(403).json({ error: 'No tienes permisos.' });

    db.run(`DELETE FROM ordenes_trabajo WHERE id = ?`, id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        registrarLog(user, 'Eliminar OT', `OT ID: ${id} eliminada`, { id: id }, 'APROBADO');
        res.json({ mensaje: 'OT eliminada correctamente' });
    });
});

// --- RUTAS API LOGS (AUDITORÍA) ---
app.get('/api/logs', (req, res) => db.all("SELECT * FROM logs ORDER BY id DESC", [], (err, rows) => res.json(rows)));

// EDITAR UNA PETICIÓN EN STANDBY
app.put('/api/logs/:id', (req, res) => {
    const { id } = req.params;
    const { nuevosDatos } = req.body;
    
    // Validar los nuevos datos editados
    if (nuevosDatos.codigo_ot) {
        const errorValidacion = validarOT(nuevosDatos);
        if (errorValidacion) return res.status(400).json({ error: errorValidacion });
    }

    db.run(`UPDATE logs SET datos = ? WHERE id = ?`, [JSON.stringify(nuevosDatos), id], function(err) {
        if (err) return res.status(500).json({ error: 'Error al actualizar petición' });
        res.json({ mensaje: 'Petición en standby actualizada correctamente.' });
    });
});

// GIANCARLO RESUELVE EL STANDBY
app.put('/api/logs/:id/resolver', (req, res) => {
    if (req.headers['x-rol'] !== 'admin') return res.status(403).json({ error: 'Solo Giancarlo puede aprobar esto.' });
    const { id } = req.params;
    const { resolucion, motivo } = req.body;

    db.get(`SELECT * FROM logs WHERE id = ?`, [id], (err, log) => {
        if (err || !log) return res.status(404).json({ error: 'Log no encontrado' });

        if (resolucion === 'RECHAZADO') {
            const nuevaReferencia = `RECHAZADO por Giancarlo. Motivo: ${motivo}`;
            db.run(`UPDATE logs SET estado = 'RECHAZADO', referencia = ? WHERE id = ?`, [nuevaReferencia, id], () => res.json({ mensaje: 'Petición rechazada' }));
            return;
        }

        // SI ES APROBADO
        const datos = JSON.parse(log.datos);
        
        if (log.accion === 'Añadir OT') {
            const estadoInicial = datos.fecha_completada ? 'HECHO' : 'PENDIENTE';
            const query = `INSERT INTO ordenes_trabajo (codigo_ot, fecha_encargo, fecha_completada, horas, num_tecnicos, marca, tipo_urgencia, materiales_precio, estado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
            db.run(query, [datos.codigo_ot, datos.fecha_encargo, datos.fecha_completada, datos.horas, datos.num_tecnicos, datos.marca, datos.tipo_urgencia, datos.materiales_precio, estadoInicial], function(err) {
                if (err) return res.status(500).json({ error: 'La OT ya fue añadida o el código existe.' });
                db.run(`UPDATE logs SET estado = 'APROBADO', referencia = ? WHERE id = ?`, [`APROBADO por Giancarlo`, id], () => res.json({ mensaje: 'Petición aprobada y OT creada' }));
            });
        } 
        else if (log.accion === 'Eliminar OT') {
            db.run(`DELETE FROM ordenes_trabajo WHERE id = ?`, [datos.id], function(err) {
                db.run(`UPDATE logs SET estado = 'APROBADO', referencia = ? WHERE id = ?`, [`APROBADO por Giancarlo`, id], () => res.json({ mensaje: 'Petición aprobada y OT eliminada' }));
            });
        }
        else if (log.accion === 'Editar OT') {
            db.run(`UPDATE ordenes_trabajo SET estado = ? WHERE id = ?`, [datos.nuevoEstado, datos.id], function(err) {
                db.run(`UPDATE logs SET estado = 'APROBADO', referencia = ? WHERE id = ?`, [`APROBADO por Giancarlo`, id], () => res.json({ mensaje: 'Petición aprobada y estado cambiado' }));
            });
        }
    });
});

app.post('/api/factura', async (req, res) => {
    const { ot_id, codigo_ot, base_imponible, iva, total } = req.body;
    const fecha_emision = new Date().toISOString().split('T')[0];
    const textoQR = `NIF:B-12345678|FacturaRef:${codigo_ot}|Fecha:${fecha_emision}|Total:${total}EUR`;
    try {
        const qr_imagen = await QRCode.toDataURL(textoQR);
        db.run(`INSERT INTO facturas (ot_id, base_imponible, iva, total, qr_data, fecha_emision) VALUES (?, ?, ?, ?, ?, ?)`, [ot_id, base_imponible, iva, total, qr_imagen, fecha_emision], function(err) {
            if (err) return res.status(500).json({ error: 'Error.' });
            res.status(200).json({ mensaje: '¡Factura emitida!', qr_data: qr_imagen });
        });
    } catch (error) { res.status(500).json({ error: 'Error QR.' }); }
});

app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
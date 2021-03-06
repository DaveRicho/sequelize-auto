var Sequelize = require('sequelize');
var async = require('async');
var fs = require('graceful-fs-extra');
var path = require('path');
var mkdirp = require('mkdirp');
var dialects = require('./dialects');
var _ = Sequelize.Utils._;

function AutoSequelize(database, username, password, options) {
  if (database instanceof Sequelize) {
    this.sequelize = database;
  } else {
      this.sequelize = new Sequelize(database, username, password, options || {});
  }

  this.queryInterface = this.sequelize.getQueryInterface();
  this.tables = {};
  this.foreignKeys = {};
  this.dialect = dialects[this.sequelize.options.dialect];

  this.options = _.extend({
    global: 'Sequelize',
    local: 'sequelize',
    spaces: false,
    indentation: 1,
    directory: './models',
    additional: {},
    freezeTableName: true
  }, options || {});
}

AutoSequelize.prototype.build = function(callback) {
  var self = this;

  function mapTable(table, _callback){
    self.queryInterface.describeTable(table).then(function(fields) {
      self.tables[table] = fields
      _callback();
    }, _callback);
  }

  this.queryInterface.showAllTables().then(function (__tables) {
    if (self.sequelize.options.dialect === 'mssql')
      __tables = _.map(__tables, 'tableName');

    var tables = self.options.tables ? _.intersection(__tables, self.options.tables) : __tables;

    async.each(tables, mapForeignKeys, mapTables)

    function mapTables(err) {
      if (err) console.error(err)

      async.each(tables, mapTable, callback);
    }
  }, callback);

  function mapForeignKeys(table, fn) {
    if (! self.dialect) return fn()

    var sql = self.dialect.getForeignKeysQuery(table, self.sequelize.config.database)

    self.sequelize.query(sql, {
      type: self.sequelize.QueryTypes.SELECT,
      raw: true
    }).then(function (res) {
      _.each(res, assignColumnDetails)
      fn()
    }, fn);

    function assignColumnDetails(ref) {
      // map sqlite's PRAGMA results
      ref = _.mapKeys(ref, function (value, key) {
        switch (key) {
        case 'from':
          return 'source_column';
        case 'to':
          return 'target_column';
        case 'table':
          return 'target_table';
        default:
          return key;
        }
      });

      ref = _.assign({
        source_table: table,
        source_schema: self.sequelize.options.database,
        target_schema: self.sequelize.options.database
      }, ref);

      if (! _.isEmpty(_.trim(ref.source_column)) && ! _.isEmpty(_.trim(ref.target_column)))
        ref.isForeignKey = true

      if (_.isFunction(self.dialect.isPrimaryKey) && self.dialect.isPrimaryKey(ref))
        ref.isPrimaryKey = true

       if (_.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(ref))
         ref.isSerialKey = true

      self.foreignKeys[table] = self.foreignKeys[table] || {};
      self.foreignKeys[table][ref.source_column] = _.assign({}, self.foreignKeys[table][ref.source_column], ref);
    }
  }
}

AutoSequelize.prototype.run = function(callback) {
  var self = this;
  var text = {};
  var tables = [];

  this.build(generateText);

  function generateText(err) {
    var quoteWrapper = '"';
    if (err) console.error(err)

    async.each(_.keys(self.tables), function(table, _callback){
      var fields = _.keys(self.tables[table])
        , spaces = '';

      for (var x = 0; x < self.options.indentation; ++x) {
        spaces += (self.options.spaces === true ? ' ' : "\t");
      }

      text[table] = "/* jshint indent: " + self.options.indentation + " */\n\n";
      text[table] = "Moment = require('moment');\n";
      text[table] += "module.exports = function(sequelize, DataTypes) {\n";
      var tableName = self.options.camelCase ? _.camelCase(table) : table;
      text[table] += spaces + "return sequelize.define('" + tableName + "', {\n";

      _.each(fields, function(field, i){
        // Find foreign key
        var foreignKey = self.foreignKeys[table] && self.foreignKeys[table][field] ? self.foreignKeys[table][field] : null

        if (_.isObject(foreignKey)) {
          self.tables[table][field].foreignKey = foreignKey
        }

        // column's attributes
        var fieldAttr = _.keys(self.tables[table][field]);
        var fieldName = self.options.camelCase ? _.camelCase(field) : field;
        text[table] += spaces + spaces + fieldName + ": {\n";
        

        // Serial key for postgres...
        var defaultVal = self.tables[table][field].defaultValue;

        // ENUMs for postgres...
        if (self.tables[table][field].type === "USER-DEFINED" && !! self.tables[table][field].special) {
          self.tables[table][field].type = "ENUM(" + self.tables[table][field].special.map(function(f){ return quoteWrapper + f + quoteWrapper; }).join(',') + ")";
        }

        _.each(fieldAttr, function(attr, x){
          var isSerialKey = self.tables[table][field].foreignKey && _.isFunction(self.dialect.isSerialKey) && self.dialect.isSerialKey(self.tables[table][field].foreignKey)
          
          // We don't need the special attribute from postgresql describe table..
          if (attr === "special") {
            return true;
          }

          if (attr === "foreignKey") {
            if (isSerialKey) {
              text[table] += spaces + spaces + spaces + "autoIncrement: true";
            }
            else if (foreignKey.isForeignKey) {
              text[table] += spaces + spaces + spaces + "references: {\n";
              text[table] += spaces + spaces + spaces + spaces + "model: \'" + self.tables[table][field][attr].target_table + "\',\n"
              text[table] += spaces + spaces + spaces + spaces + "key: \'" + self.tables[table][field][attr].target_column + "\'\n"
              text[table] += spaces + spaces + spaces + "}"
            } else return true;
          }
          else if (attr === "primaryKey") {
             if (self.tables[table][field][attr] === true && (! _.has(self.tables[table][field], 'foreignKey') || (_.has(self.tables[table][field], 'foreignKey') && !! self.tables[table][field].foreignKey.isPrimaryKey)))
              text[table] += spaces + spaces + spaces + "primaryKey: true";
            else return true
          }
          else if (attr === "allowNull") {
            text[table] += spaces + spaces + spaces + attr + ": " + self.tables[table][field][attr];
          }
          else if (attr === "defaultValue") {
            if ( self.dialect === 'mssql' &&  defaultVal.toLowerCase() === '(newid())' ) {
              defaultVal = null; // disable adding "default value" attribute for UUID fields if generating for MS SQL
            }

            var val_text = defaultVal;

            if (isSerialKey) return true

            //mySql Bit fix
            if (self.tables[table][field].type.toLowerCase() === 'bit(1)') {
              val_text = defaultVal === "b'1'" ? 1 : 0;
            }

            if (_.isString(defaultVal)) {
              var field_type = self.tables[table][field].type.toLowerCase();
              if (field_type.indexOf('date') === 0 || field_type.indexOf('timestamp') === 0) {
                if (_.endsWith(defaultVal, '()')) {
                  val_text = "sequelize.fn('" + defaultVal.replace(/\(\)$/, '') + "')"
                }
                else if (_.includes(['current_timestamp', 'current_date', 'current_time', 'localtime', 'localtimestamp'], defaultVal.toLowerCase())) {
                  val_text = "sequelize.literal('" + defaultVal + "')"
                } else {
                  val_text = quoteWrapper + val_text + quoteWrapper
                }
              } else {
                val_text = quoteWrapper + val_text + quoteWrapper
              }
            }
            if(defaultVal === null) {
              return true;
            } else {
              text[table] += spaces + spaces + spaces + attr + ": " + val_text;
            }
          }
          else if (attr === "type" && self.tables[table][field][attr].indexOf('ENUM') === 0) {
            text[table] += spaces + spaces + spaces + attr + ": DataTypes." + self.tables[table][field][attr];
          } else {
            var _attr = (self.tables[table][field][attr] || '').toLowerCase();
            var val = quoteWrapper + self.tables[table][field][attr] + quoteWrapper;
            if (_attr === "boolean" || _attr === "bit(1)") {
              val = 'DataTypes.BOOLEAN';
            }
            else if (_attr.match(/^(smallint|mediumint|tinyint|int)/)) {
              var length = _attr.match(/\(\d+\)/);
              //val = 'DataTypes.INTEGER' + (!  _.isNull(length) ? length : '');
              val = 'DataTypes.INTEGER' + (_attr.match(/\(\d+\)/) ? length[0] : '');
            }
            else if (_attr.match(/^bigint/)) {
              val = 'DataTypes.BIGINT';
            }
            else if (_attr.match(/^varchar/)) {
              var length = _attr.match(/\(\d+\)/);
              val = 'DataTypes.STRING' + (!  _.isNull(length) ? length : '');
              //swa edit
              if (length>255){
                val = 'DataTypes.TEXT';
              }
            }
            //swa edit
            else if (_attr.match(/^nvarchar/)) {
              val = 'DataTypes.TEXT';
              // let length = _attr.match(/\d+/);
              // val = 'DataTypes.STRING'; //+ (!  _.isNull(length) ? length : '');
              // console.log('_attr: ' + _attr) ; 
              // console.log('length: ' + length) ; 
              // console.dir(self.tables[table][field]);              
              // if (length) {
              //   if (length[0] > 255) {
              //     val = 'DataTypes.TEXT';
              //   }
              // } 
            else if (_attr.match(/^string|varchar|varying|nvarchar/)) {
              var length = _attr.match(/\(\d+\)/);
              //val = 'DataTypes.STRING';
              //val = 'DataTypes.STRING' + (!  _.isNull(length) ? length : '');  
              val = 'DataTypes.STRING' + (_attr.match(/\(\d+\)/) ? length[0] : '');
              //console.log('field:' + field);
              //console.log('fields:' + fields);
              //console.log('fieldAttr:' + fieldAttr);
              //console.log('attr:' + attr);
              //console.log('_attr:' + _attr);
              
            }
            else if (_attr.match(/^char/)) {
              var length = _attr.match(/\(\d+\)/);
              //val = 'DataTypes.CHAR' + (!  _.isNull(length) ? length : '');
              val = 'DataTypes.CHAR' + (_attr.match(/\(\d+\)/) ? length[0] : '');
            }
            else if (_attr.match(/text|ntext$/)) {
              val = 'DataTypes.TEXT';
            }
            else if (_attr.match(/^(date)/)) {
              val = 'DataTypes.DATE';
            }
            // swa edit
            else if (_attr.match(/^(smalldatetime)/)) {
              val = 'DataTypes.DATE';
            }
            else if (_attr.match(/^(time)/)) {
              val = 'DataTypes.TIME';
            }
            else if (_attr.match(/^(float|float4)/)) {
              val = 'DataTypes.FLOAT';
            }
            else if (_attr.match(/^decimal/)) {
              val = 'DataTypes.DECIMAL';
            }
            // else if (_attr.match(/^(float8|double precision)/)) { //swa edit
            else if (_attr.match(/^(float8|double precision|numeric|money)/)) {
              val = 'DataTypes.DOUBLE';
            }
            else if (_attr.match(/^uuid|uniqueidentifier/)) {
              val = 'DataTypes.UUIDV4';
            }
            else if (_attr.match(/^json/)) {
              val = 'DataTypes.JSON';
            }
            else if (_attr.match(/^jsonb/)) {
              val = 'DataTypes.JSONB';
            }
            else if (_attr.match(/^geometry/)) {
              val = 'DataTypes.GEOMETRY';
            }
            text[table] += spaces + spaces + spaces + attr + ": " + val;
          }

          text[table] += ",";
          text[table] += "\n";
          
           // conditionally add dateformatting for SMALLDATETIME strings
          // get: function(){ 
          // if (!Moment(this.getDataValue('client_first_earliest_start_date')).isValid()) {
          //   return null;
          // }
          // // return Moment(this.getDataValue('client_date_recent_full_soa')).format('YYYY-MM-DD HH:mm:ss');.
         //   }
         
          if (attr === "type") {
            var field_type2 = self.tables[table][field].type.toLowerCase();
            if (field_type2.match(/^date/) || field_type2.match(/^smalldatetime/)) {
              text[table] += spaces + spaces + spaces + "get: function(){";
              text[table] += "\n";
              text[table] += spaces + spaces + spaces + spaces + `if (!Moment(this.getDataValue('${fieldName}')).isValid()) {`;
              text[table] += "\n";
              text[table] += spaces + spaces + spaces + spaces + spaces + spaces + "return null;";
              text[table] += "\n";
              text[table] += spaces + spaces + spaces + spaces + "}";
              text[table] += "\n";
              text[table] += spaces + spaces + spaces + spaces + `return Moment(this.getDataValue('${fieldName}')).format('YYYY-MM-DD HH:mm:ss');`;
              text[table] += "\n";
              text[table] += spaces + spaces + spaces + "}";
              text[table] += ",\n";
            }
          } 
          
        });
        if (self.options.camelCase) {
          text[table] += spaces + spaces + spaces + "field: '" + field + "',\n";
        }
        // removes the last `,` within the attribute options
        text[table] = text[table].trim().replace(/,+$/, '') + "\n";

        text[table] += spaces + spaces + "}";
        if ((i+1) < fields.length) {
          text[table] += ",";
        }
        text[table] += "\n";
      });

      text[table] += spaces + "}";

      //conditionally add additional options to tag on to orm objects
      var hasadditional = _.isObject(self.options.additional) && _.keys(self.options.additional).length > 0;

      text[table] += ", {\n";

      text[table] += spaces + spaces  + "tableName: '" + table + "',\n";
      
      /*
      common extra legacy models stuff
      // don't add the timestamp attributes (updatedAt, createdAt)
      timestamps: false,      
      freezeTableName: true,    
      hasTrigger: true
      */
      text[table] += spaces + spaces  + "timestamps: false,\n";
      text[table] += spaces + spaces  + "freezeTableName: true,\n";
      text[table] += spaces + spaces  + "//hasTrigger: true,\n";

      if (hasadditional) {
        _.each(self.options.additional, addAdditionalOption)
      }

      text[table] = text[table].trim()
      text[table] = text[table].substring(0, text[table].length - 1);
      text[table] += "\n" + spaces + "}";

      function addAdditionalOption(value, key) {
        if (key === 'name') {
          // name: true - preserve table name always
          text[table] += spaces + spaces + "name: {\n";
          text[table] += spaces + spaces + spaces + "singular: '" + table + "',\n";
          text[table] += spaces + spaces + spaces + "plural: '" + table + "'\n";
          text[table] += spaces + spaces + "},\n";
        }
        else {
          text[table] += spaces + spaces + key + ": " + value + ",\n";
        }
      }

      //resume normal output
      text[table] += ");\n};\n";
      _callback(null);
    }, function(){
      self.sequelize.close();
      self.write(text, callback);
    });
  }
}

AutoSequelize.prototype.write = function(attributes, callback) {
  var tables = _.keys(attributes);
  var self = this;

  mkdirp.sync(path.resolve(self.options.directory))

  async.each(tables, createFile, callback)

  function createFile(table, _callback){
    fs.writeFile(path.resolve(path.join(self.options.directory, table + '.js')), attributes[table], _callback);
  }
}

module.exports = AutoSequelize

class DataSourcesUi {
  
  #id = undefined;
  #datasources = {};
  
  constructor(id){
    this.#id = id;

    var dom = this.getDom();
    
    dom.addEventListener('dragenter', this.#dragEnterHandler.bind(this));
    dom.addEventListener('dragleave', this.#dragLeaveHandler.bind(this));
    dom.addEventListener('dragover', this.#dragOverHandler.bind(this));
    dom.addEventListener('drop', this.#dropHandler.bind(this));
  }

  #dragEnterHandler(event) {
    var valid = true;
    
    var dataTransfer = event.dataTransfer;
    dataTransfer.dropEffect = 'copy';
    return;
    var files = dataTransfer.files;
    valid = Boolean(files.length);
    var fileTypes = DuckDbDataSource.fileTypes;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      var fileName = file.name;
      var fileNameParts = DuckDbDataSource.getFileNameParts(fileName);
      var fileExtension = fileNameParts.lowerCaseExtension;
      var fileType = fileTypes[fileExtension];
      valid = Boolean(fileType);
      if (!valid){
        break;
      }
    }
    this.getDom().setAttribute('data-drop-allowed', valid);
    event.stopPropagation(); 
    event.preventDefault();
  }

  #dragLeaveHandler(event) {
    event.stopPropagation(); 
    event.preventDefault();
    this.getDom().setAttribute('data-drop-allowed', '');
  }

  #dragOverHandler(event) {
    event.stopPropagation(); 
    event.preventDefault();
    
    var dataTransfer = event.dataTransfer;
    console.log('dragover');
  }

  #dropHandler(event) {
    event.preventDefault();
    event.stopPropagation(); 
    var dataTransfer = event.dataTransfer;
    var files = dataTransfer.files;
    if (files.length) {
      uploadUi.uploadFiles(files);
    }
    console.log('drop');
  }
    
  getDom(){
    return byId(this.#id);
  }
  
  clear(){
    this.getDom().innerHTML = '';
  }
  
  #renderDatasourceActionButton(config){
    var actionButton = createEl('label', {
      "class": 'button' + (config.className ? ' ' + (typeof config.className instanceof Array ? config.className.join(' ') : config.className ) : ''),
      "for": config.id,
      title: config.title
    });

    var button = createEl('button',{
      id: config.id
    });
    actionButton.appendChild(button);
    
    var events = config.events; 
    if (events) {
      for (var eventName in events) {
        var handler = events[eventName];
        button.addEventListener(eventName, handler);
      }
    }
    
    return actionButton;
  }
  
  async #getTabularDatasourceTypeSignature(datasource){
    var typeSignature;
    var type  = datasource.getType();
    var fileType = datasource.getFileExtension();
    var columnMetadata = await datasource.getColumnMetadata();
    var columnMetadataSerialized = {};
    var datasourceSettings = settings.getSettings('datasourceSettings');
    var useLooseColumnComparisonType = datasourceSettings.useLooseColumnTypeComparison;
    var looseColumnTypes = datasourceSettings.looseColumnTypes;
    for (var i = 0; i < columnMetadata.numRows; i++){
      var row = columnMetadata.get(i);
      
      var columnType = row.column_type;
      var comparisonColumnType = undefined;
      if (useLooseColumnComparisonType) {
        for (var looseType in looseColumnTypes){
          var columnTypes = looseColumnTypes[looseType];
          if (columnTypes.indexOf(columnType) === -1) {
            continue;
          }
          comparisonColumnType = looseType;
        }
      }
      if (comparisonColumnType === undefined) {
        comparisonColumnType = columnType;
      }
      columnMetadataSerialized[row.column_name] = comparisonColumnType;
    }
    var columnMetadataSerializedJSON = JSON.stringify(columnMetadataSerialized);
    typeSignature = `${type}:${fileType}:${columnMetadataSerializedJSON}`; 
    return typeSignature;
  }
  
  async #renderDatasources(){
    this.clear();    
    var node, group, potentialGroups = {};
    var datasources = this.#datasources;

    var groupingPromises = Object.keys(datasources).map(async function(datasourceId){
      var datasource = datasources[datasourceId];
      var type = datasource.getType();
      
      var group = undefined;
      switch (type){
        case DuckDbDataSource.types.FILE:
          var typeSignature = await this.#getTabularDatasourceTypeSignature(datasource);
          group = potentialGroups[typeSignature];
          if (!group) {
            potentialGroups[typeSignature] = group = {
              type: DuckDbDataSource.types.FILE,
              fileType: datasource.getFileExtension(),
              typeSignature: typeSignature,
              datasources: {}
            };
          }
          break;
        case DuckDbDataSource.types.DUCKDB:
        case DuckDbDataSource.types.SQLITE:
        default:
          group = potentialGroups[type];
          if (!group){
            potentialGroups[type] = group = {
              type: type,
              datasources: {}
            };
          }
      }
      group.datasources[datasourceId] = datasource;
      return true;
    }.bind(this));
    await Promise.all(groupingPromises);
    
    this.#createDataSourceGroupNode(potentialGroups[DuckDbDataSource.types.DUCKDB]);
    delete potentialGroups[DuckDbDataSource.types.DUCKDB];
    
    this.#createDataSourceGroupNode(potentialGroups[DuckDbDataSource.types.SQLITE]);
    delete potentialGroups[DuckDbDataSource.types.SQLITE];
    
    for (var groupId in potentialGroups){
      var group = potentialGroups[groupId];
      var datasources = group.datasources;
      var datasourceKeys = Object.keys(datasources);
      if (datasourceKeys.length === 1) {
        var datasourceKey = datasourceKeys[0]
        var datasource = datasources[datasourceKey];
        var datasourceType = datasource.getType();
        var miscGroup = potentialGroups[datasourceType];
        if (!miscGroup) {
          miscGroup = potentialGroups[datasourceType] = {
            type: datasourceType,
            datasources: {}
          }
        }
        miscGroup.datasources[datasource.getId()] = datasource;
      }
      else {
        this.#createDataSourceGroupNode(group);
      }
      delete potentialGroups[groupId];
    }

    this.#createDataSourceGroupNode(potentialGroups[DuckDbDataSource.types.FILE], true);
    delete potentialGroups[DuckDbDataSource.types.FILE];
  }
  
  static getCaptionForDatasource(datasource){
    var type = datasource.getType();
    switch (type){ 
      case DuckDbDataSource.types.DUCKDB:
      case DuckDbDataSource.types.SQLITE:
      case DuckDbDataSource.types.FILE:
        return datasource.getFileNameWithoutExtension();
      default:
        return datasource.getId();
    }
  }
  
  #createDatasourceNodeActionButtons(datasourceId, summaryElement) {
    var analyzeActionButton = this.#renderDatasourceActionButton({
      id: datasourceId + '_analyze',
      "className": "analyzeActionButton",
      title: 'Open the this datasource in the Query editor',
      events: {
        click: this.#analyzeDatasourceClicked.bind(this)
      }
    });
    summaryElement.appendChild(analyzeActionButton);

    var removeActionButton = this.#renderDatasourceActionButton({
      id: datasourceId + '_remove',
      "className": "removeActionButton",
      title: 'Remove this datasource',
      events: {
        click: this.#removeDatasourceClicked.bind(this)
      }
    });
    summaryElement.appendChild(removeActionButton);
  }
  
  #createDatasourceNode(datasource){
    var caption = DataSourcesUi.getCaptionForDatasource(datasource);

    var type = datasource.getType();
    var dataSourceId = datasource.getId();
    var datasourceNode = createEl('details', {
      id: dataSourceId,
      role: 'treeitem',
      "data-nodetype": 'datasource',
      "data-sourcetype": type,
      "title": caption,
      "open": true
    });

    var extension;
    if (type === DuckDbDataSource.types.FILE) {
      extension = datasource.getFileExtension();
      datasourceNode.setAttribute('data-filetype', extension);
    }
    
    var summary = createEl('summary', {
    });
    var icon = createEl('span', {
      "class": 'icon'
    });
    summary.appendChild(icon);
    
    datasourceNode.appendChild(summary);
    
    var label = createEl('span', {
      class: 'label'
    }, caption);
    summary.appendChild(label);
    
    this.#createDatasourceNodeActionButtons(dataSourceId, summary);

    return datasourceNode;
  }
  
  #getTreeNodeFromClickEvent(event){
    var button = event.target;
    var label = button.parentNode;
    var summary = label.parentNode;
    var node = summary.parentNode;
    return node;
  }

  #getDatasourceForTreeNode(datasourceTreeNode) {
    var dataSourceId = datasourceTreeNode.id;
    var datasource = this.getDatasource(dataSourceId);
    return datasource;
  }
  
  #getDatasourceFromClickEvent(event){
    var node = this.#getTreeNodeFromClickEvent(event);
    var nodeType = node.getAttribute('data-nodetype');
    
    var datasource;
    switch (nodeType) {
      case 'datasource':
        var datasource = this.#getDatasourceForTreeNode(node);
        break;
      case 'datasourcegroup':
        var groupType = node.getAttribute('data-grouptype');
        switch (groupType){
          case DuckDbDataSource.types.FILE:
            var datasourceIdsListJSON = node.getAttribute('data-datasourceids');
            var datasourceIdsList = JSON.parse(datasourceIdsListJSON);
            var fileNames = datasourceIdsList.map(function(datasourceId){
              var datasource = this.#datasources[datasourceId];
              var fileName = datasource.getFileName();
              return fileName;
            }.bind(this));
            var fileType = node.getAttribute('data-filetype');

            var hueyDb = window.hueyDb;
            var duckdb = hueyDb.duckdb;
            var instance = hueyDb.instance;            
            datasource = new DuckDbDataSource(duckdb, instance, {
              type: DuckDbDataSource.types.FILES,
              fileNames,
              fileType: fileType
            });
            break;
          default:
            throw new Error(`Don't know how to get a datasource from a datasourcegroup of type ${groupType}`);
        }
        break;
      default:
        throw new Error(`Don't know how to get a datasource for node of type ${nodeType}.`);
    }    
    return datasource;
  }

  #analyzeDatasourceClicked(event){    
    var datasource = this.#getDatasourceFromClickEvent(event);
    // todo: replace direct call to global analyze with fireEvent
    analyzeDatasource(datasource);
  }
  
  #removeDatasourceClicked(event){
    var node = this.#getTreeNodeFromClickEvent(event);
    var nodeType = node.getAttribute('data-nodetype');
    var datasourceIdsList;
    switch (nodeType) {
      case 'datasource':
        var dataSourceId = node.id;
        datasourceIdsList = [dataSourceId];
        break;
      case 'datasourcegroup':
        var groupType = node.getAttribute('data-grouptype');
        switch (groupType){
          case DuckDbDataSource.types.FILE:
            var datasourceIdsListJSON = node.getAttribute('data-datasourceids');
            datasourceIdsList = JSON.parse(datasourceIdsListJSON);
            break;
          default:
            throw new Error(`Don't know how to get a datasource from a datasourcegroup of type ${groupType}`);
        }
        break;
    }    
    this.destroyDatasources(datasourceIdsList);
  }
  
  #getCaptionForDataSourceGroup(datasourceGroup, miscGroup){
    switch (datasourceGroup.type) {
      case DuckDbDataSource.types.DUCKDB:
        return 'DuckDB';
      case DuckDbDataSource.types.SQLITE:
        return 'SQLite';
      case DuckDbDataSource.types.FILE:
        var datasources = datasourceGroup.datasources;
        if (miscGroup) {
          return 'Files';
        }
        return Object.keys(datasources).map(function(datasourceId){
          var datasource = datasources[datasourceId];
          return datasource.getFileNameWithoutExtension();
        }).join(', ');
    }
  }
  
  #createDataSourceGroupNode(datasourceGroup, miscGroup){
    if (datasourceGroup === undefined){ 
      return;
    }

    var groupType = datasourceGroup.type;
    var groupNode = createEl('details', {
      role: 'treeitem',
      "data-nodetype": 'datasourcegroup',
      "data-grouptype": groupType,
      open: true
    });

    var groupTitle;
    switch (groupType) {
      case DuckDbDataSource.types.FILE:
        if (miscGroup === true) {
          groupTitle = 'Miscellanous files';
        }
        else {
          groupNode.setAttribute('data-filetype', datasourceGroup.fileType);
        }
        
        if (datasourceGroup.typeSignature) {
          groupTitle = 'Bucked of similarly typed files.';
        }
        break;
      default:
        groupTitle = `${groupType}`;
    }
    groupNode.setAttribute('title', groupTitle);
    
    var summary = createEl('summary', {
    });
    groupNode.appendChild(summary);
    
    var icon = createEl('span', {
      "class": 'icon'
    });
    summary.appendChild(icon);
    
    var caption = this.#getCaptionForDataSourceGroup(datasourceGroup, miscGroup);
    var label = createEl('span', {
      class: 'label'
    }, caption);
    summary.appendChild(label);
    
    if (datasourceGroup.typeSignature) {
      this.#createDatasourceNodeActionButtons(datasourceGroup.typeSignature, summary);
    }
    
    var datasources = datasourceGroup.datasources;
    var datasourceKeys = Object.keys(datasources);
    groupNode.setAttribute('data-datasourceids', JSON.stringify(datasourceKeys));
    datasourceKeys.map(function(datasourceId){
      var datasource = datasources[datasourceId];
      var datasourceNode = this.#createDatasourceNode(datasource);
      groupNode.appendChild(datasourceNode);
    }.bind(this));
    
    var dom = this.getDom();
    dom.appendChild(groupNode);
    return groupNode;
  }
  
  addDatasources(datasources){
    datasources.forEach(function(datasource){
      var id = datasource.getId();
      this.#datasources[id] = datasource;
    }.bind(this));
    this.#renderDatasources();
  }
  
  destroyDatasources(datasourceIds) {
    for (var i = 0; i < datasourceIds.length; i++){
      var datasourceId = datasourceIds[i];
      var datasource = this.getDatasource(datasourceId);
      if (!datasource) {
        continue;
      }
      datasource.destroy();
      delete this.#datasources[datasourceId];
    }
    this.#renderDatasources();
  }
  
  getDatasource(id) {
    return this.#datasources[id];
  }
}

var datasourcesUi;
function initDataSourcesUi(){
  datasourcesUi = new DataSourcesUi('datasourcesUi');
}
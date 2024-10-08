import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import Yaml from 'yaml'
import fs from 'fs'
import { YamlEditor, redis as db } from 'node-karin'
import { common } from '@plugin/imports'
import Permissions from './permissions'

interface User {
  username: string
  password: string
  routes: Array<string>
  status: string
  permissions: Permissions
}

interface UserLogin {
  user?:string
  token: string
  tokenExpiry: Date | null
  routes: Array<string>
}

class UserManager {
  users: User[]
  secretKey: string | undefined

  constructor() {
    this.users = []
    this.init()
  }

  async init() {
    this.secretKey = await this.getSecretKey()
    this.users = this.loadUsersFromYAML()
  }

  tempYaml(): YamlEditor {
    if (!fs.existsSync('data/karin-plugin-manage/temp.yaml')) {
      fs.writeFileSync('data/karin-plugin-manage/temp.yaml', '', 'utf8')
    }
    return new YamlEditor('data/karin-plugin-manage/temp.yaml')
  }

  /**
   * 从YAML文件加载用户信息
   * @returns {any} 用户信息
   */
  loadUsersFromYAML(): any {
    // 初始化用户配置
    if (!fs.existsSync('data/karin-plugin-manage/user.yaml')) {
      fs.writeFileSync('data/karin-plugin-manage/user.yaml', '', 'utf8')
    }
    const yamlEditor = new YamlEditor('data/karin-plugin-manage/user.yaml')
    let userData = yamlEditor.get('') || []
    if (this.secretKey) {
      for (const i in userData) {
        userData[i].permissions = new Permissions(userData[i].username, this.secretKey)
      }
    }
    return userData
  }

  /**
   * 获取secretKey
   * @returns {string} secretKey
   */
  async getSecretKey() {
    const tempData = this.tempYaml()
    let secretKey: string
    try {
      secretKey = await db.get(`karin-plugin-manage:secretKey`) ?? ''
    } catch (error) {
      secretKey = tempData.get('secretKey')
    }
    if (!secretKey) {
      secretKey = crypto.randomBytes(64).toString('hex')
      try {
        await db.set('karin-plugin-manage:secretKey', secretKey)
      } catch (error) {
        tempData.set('secretKey', secretKey)
        tempData.save()
      }
    }
    return secretKey
  }


  /**
   * 添加用户
   * @param {string} username 用户名
   * @param {string} password 密码
   * @param {any} routes 权限
   */
  addUser(username: string, password: string, routes: any) {
    if (this.checkUser(username) || !this.secretKey) return
    const hashedPassword: string = bcrypt.hashSync(common.md5(password), 10)
    const newUser: User = {
      username,
      password: hashedPassword,
      routes,
      status: 'enabled', // 默认启用账号
      permissions: new Permissions(username, this.secretKey)
    }
    this.users.push(newUser)
    this.saveUserToYAML(newUser)
  }

  saveUserToYAML(user: User) {
    const yamlEditor = new YamlEditor('data/karin-plugin-manage/user.yaml')
    yamlEditor.pusharr(user)
    yamlEditor.save()
  }

  // 修改用户信息到YAML文件
  saveUserDataToYAML(user: string, key: string, value: string | any) {
    if (!this.checkUser(user)) return
    const yamlEditor = new YamlEditor('data/karin-plugin-manage/user.yaml')
    const document: Yaml.Document | null = yamlEditor.document
    if (document) {
      const current: Yaml.Node | null = document.contents
      if (current) {
        if (current instanceof Yaml.YAMLSeq) {
          for (let i in current.items) {
            let target: boolean = false
            let ySeq = current.items[i]
            if (ySeq instanceof Yaml.YAMLMap) {
              for (let l in ySeq.items) {
                let yMap = ySeq.items[l]
                if (yMap instanceof Yaml.Pair) {
                  if (yMap.key.value === 'username' && yMap.value.value === user) {
                    target = true
                  }
                  if (yMap.key.value === key && target) {
                    if (typeof value === "string") {
                      yMap.value.value = value
                    } else {
                      const yamlSeq = new Yaml.YAMLSeq()
                      value.forEach((element: unknown) => {
                        yamlSeq.add(element)
                      })
                      yMap.value = yamlSeq
                    }
                  }
                }
              }
            }
          }
        }
        yamlEditor.save()
      }
    }
  }

  /**
   * 检查用户是否存在
   * @param {string} username 用户名
   * @returns {boolean} 是否存在
   */
  checkUser(username: string): boolean {
    const user = this.users.find(u => u.username === username)
    return !!user
  }

  /**
   * 系统登录接口
   * @param {string} username 用户名
   * @param {string} password 密码
   * @param {boolean} remember 持久登陆
   * @returns {UserLogin|null} 用户信息
   */
  // 系统登录接口
  async login(username: string, password: string, remember?: boolean): Promise<UserLogin | null> {
    const user: User | undefined = this.users.find(u => u.username === username)
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return null
    }

    const token: string | undefined = jwt.sign({ username, routes: user.routes }, user.permissions?.secretKey ?? '', remember ? undefined : { expiresIn: '1h' })
    if (token) {
      await user.permissions.setToken(token, remember)
      const tokenExpiry = remember ? null : new Date(new Date().getTime() + 60 * 60 * 1000)
      return { token, tokenExpiry, routes: user.routes }
    }
    return null
  }

  /**
   * 系统快速登录接口
   * @param {string} otp 验证码
   * @param {string} username 用户名
   * @returns {UserLogin|null} 用户信息
   */
  async quickLogin(otp: string, username: string): Promise<UserLogin | null> {
    let user = this.users.find(u => u.username === username)
    if (!user) {
      user = this.users.find(u => bcrypt.compareSync(u.username.toString(), username.toString()))
    }
    if (user) {
      const auth = await user.permissions.getOtp()
      if (otp != auth) {
        return null
      }
      const token: string | undefined = jwt.sign({ username: user.username, routes: user.routes }, user.permissions?.secretKey ?? '', { expiresIn: '1h' })
      if (token) {
        await user.permissions.setToken(token, false)
        await user.permissions.delOtp()
        const tokenExpiry = new Date(new Date().getTime() + 60 * 60 * 1000)
        return { user: user.username,token, tokenExpiry, routes: user.routes }
      }
    }
    return null
  }

  /**
   * 注销接口
   * @param {string} username 用户名
   * @param {string} token Token
   * @returns {booleanl} 是否注销成功
   */
  async logout(username: string, token: string): Promise<boolean> {
    let user = this.users.find(u => u.username === username)
    if (user) {
      const currentToken: string | null = await user.permissions.getToken()
      if (token === currentToken) {
        await user.permissions.delToken()
        return true
      }
    }
    return false
  }

  /**
   * 验证密码
   * @param {string} username 用户名
   * @param {string} password 密码
   * @returns {booleanl} 是否通过验证
   */
  validatePassword(username: string, password: string): boolean {
    const user = this.users.find(u => u.username === username)
    if (user) {
      return bcrypt.compareSync(password, user.password)
    }
    return false
  }

  /**
   * 修改密码
   * @param {string} username 用户名
   * @param {string} password 密码
   * @returns {booleanl} 是否修改成功
   */
  changePassword(username: string, password: string): boolean {
    const user = this.users.find(u => u.username === username)
    if (user) {
      const hashedNewPassword = bcrypt.hashSync(password, 10)
      user.password = hashedNewPassword
      // 修改配置文件
      this.saveUserDataToYAML(username, 'password', hashedNewPassword)
      return true
    }
    return false
  }

  /**
   * 更新用户权限
   * @param {string} username 用户名
   * @param {Array<string>} perm 权限
   * @returns {booleanl} 是否修改成功
   */
  changePermissions(username: string, perm: Array<string>): boolean {
    // 查找用户并更新权限
    const user = this.users.find(u => u.username === username)
    if (!user) {
      throw new Error('User not found')
    }
    // 更新用户权限
    user.routes = perm
    // 修改配置文件
    this.saveUserDataToYAML(username, 'routes', perm)
    return true
  }

  /**
   * 更新token过期时间
   * @param {string} username 用户名
   * @param {string} token Token
   * @returns {booleanl} 是否更新成功
   */
  async refreshToken(username: any, token: any): Promise<boolean> {
    const user = this.users.find(u => u.username === username)
    if (user) {
      const currentToken = await user.permissions.getToken()
      if (token === currentToken) {
        await user.permissions.expireToken() // 更新token的过期时间
      }
    }
    return false
  }

}

export default new UserManager()
